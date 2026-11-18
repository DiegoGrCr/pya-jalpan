-- =============================================================================
-- 0027 · Ventas editables y cierre de venta
-- - Una venta "abierta" (confirmada y no cerrada) se puede editar: agregar/quitar productos,
--   cambiar cantidades, precios, descuentos y comentarios. Conserva el folio. El inventario se
--   ajusta por la diferencia (movimientos tipo 'venta' del mismo documento, así cancelar sigue
--   devolviendo exactamente lo neto). No se puede bajar de lo ya entregado.
-- - Si el nuevo total queda por debajo de lo pagado, la diferencia se DEVUELVE (se registra la
--   devolución con su forma) o queda como SALDO A FAVOR del cliente (se decide en cada edición).
-- - "Cerrar venta": la nota queda terminada y ya no se edita (solo se puede cancelar).
-- - Saldo a favor: se puede usar como forma de pago 'saldo_favor' al vender.
-- Requiere 0019, 0020 y 0025. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.ventas add column if not exists cerrada     boolean not null default false;
alter table public.ventas add column if not exists cerrada_en  timestamptz;
alter table public.ventas add column if not exists cerrada_por uuid;
alter table public.ventas add column if not exists editada_en  timestamptz;
alter table public.ventas add column if not exists ediciones   integer not null default 0;

alter table public.clientes add column if not exists saldo_a_favor numeric(14,2) not null default 0 check (saldo_a_favor >= 0);

-- Movimientos del saldo a favor (abonos por ediciones, cargos al usarlo en una venta)
create table if not exists public.saldo_favor_movimientos (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id),
  venta_id   uuid references public.ventas(id),
  importe    numeric(14,2) not null check (importe <> 0),   -- + abono a favor, − uso
  saldo      numeric(14,2) not null,                         -- saldo a favor después del movimiento
  concepto   text not null,
  usuario_id uuid,
  fecha      timestamptz not null default now()
);
alter table public.saldo_favor_movimientos enable row level security;
drop policy if exists saldo_favor_sel on public.saldo_favor_movimientos;
create policy saldo_favor_sel on public.saldo_favor_movimientos for select to authenticated
  using (exists (select 1 from public.perfiles where user_id = auth.uid() and activo));
grant select on public.saldo_favor_movimientos to authenticated;

-- Devoluciones de dinero por ediciones (salen en el corte de caja)
create table if not exists public.venta_devoluciones (
  id         uuid primary key default gen_random_uuid(),
  venta_id   uuid not null references public.ventas(id),
  forma      text not null check (forma in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito')),
  importe    numeric(14,2) not null check (importe > 0),
  motivo     text,
  usuario_id uuid,
  fecha      timestamptz not null default now()
);
alter table public.venta_devoluciones enable row level security;
drop policy if exists venta_devoluciones_sel on public.venta_devoluciones;
create policy venta_devoluciones_sel on public.venta_devoluciones for select to authenticated
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.opera_sucursal(v.sucursal_id)));
grant select on public.venta_devoluciones to authenticated;

alter table public.venta_pagos drop constraint if exists venta_pagos_forma_check;
alter table public.venta_pagos add constraint venta_pagos_forma_check
  check (forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia','anticipo','saldo_favor'));

-- Aplica un movimiento al saldo a favor del cliente (bloquea la fila del cliente)
create or replace function public.mover_saldo_favor(p_cliente uuid, p_importe numeric, p_venta uuid, p_concepto text)
returns numeric language plpgsql security definer set search_path = public as $$
declare v_saldo numeric;
begin
  select saldo_a_favor into v_saldo from clientes where id = p_cliente for update;
  perform exigir(v_saldo is not null, 'Cliente no encontrado');
  perform exigir(v_saldo + p_importe >= 0, format('El cliente solo tiene %s de saldo a favor', v_saldo));
  update clientes set saldo_a_favor = v_saldo + p_importe where id = p_cliente;
  insert into saldo_favor_movimientos (cliente_id, venta_id, importe, saldo, concepto, usuario_id)
  values (p_cliente, p_venta, p_importe, v_saldo + p_importe, p_concepto, auth.uid());
  return v_saldo + p_importe;
end $$;
revoke execute on function public.mover_saldo_favor(uuid, numeric, uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- editar_venta(p)
-- p: {venta_id, idempotency_key, comentarios?, orden_compra?,
--     partidas:[{partida_id?, producto_id, unidad_venta_id, cantidad, precio_unitario, descuento, comentario?, entregar_ahora?}],
--     diferencia?: 'devolver'|'saldo_favor', devolucion_forma?}
-- -----------------------------------------------------------------------------
create or replace function public.editar_venta(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v ventas%rowtype; v_cli clientes%rowtype; v_incl boolean; v_key text := p->>'idempotency_key';
  x jsonb; vp venta_partidas%rowtype; r record; c record; u unidades_venta%rowtype; pr productos%rowtype;
  v_ids uuid[] := '{}'; v_ren int; v_cb numeric; v_costo numeric; v_iva numeric; v_lista_precio numeric; v_antes numeric;
  v_delta numeric; v_falt numeric; v_pid uuid; v_cant numeric; v_precio numeric; v_desc numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
  v_exceso numeric := 0; v_saldo numeric; v_pagado numeric; v_antes_json jsonb;
begin
  perform exigir(length(coalesce(v_key,'')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('editar:' || v_key, 0));
  if exists (select 1 from bitacora where accion = 'editar' and entidad = 'ventas' and despues->>'clave' = v_key) then
    select * into v from ventas where id = (p->>'venta_id')::uuid;
    return jsonb_build_object('venta_id', v.id, 'total', v.total, 'saldo', v.saldo, 'repetida', true);
  end if;

  select * into v from ventas where id = (p->>'venta_id')::uuid for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes editar ventas de esta sucursal');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');
  perform exigir(not v.cerrada, 'La venta ya está cerrada; ya no se puede editar');
  perform exigir(v.factura_uuid is null, 'La venta está facturada; no se puede editar');
  perform exigir(jsonb_typeof(p->'partidas') = 'array' and jsonb_array_length(p->'partidas') > 0, 'La venta debe tener al menos un producto');
  select * into v_cli from clientes where id = v.cliente_id;
  select incluye_impuestos into v_incl from listas_precios where id = v.lista_id;

  v_antes_json := jsonb_build_object('total', v.total, 'partidas',
    (select jsonb_agg(jsonb_build_object('producto_id', producto_id, 'unidad', unidad_nombre, 'cantidad', cantidad, 'precio', precio_unitario, 'descuento', descuento) order by renglon)
       from venta_partidas where venta_id = v.id));

  -- Bloquea existencias de todos los productos involucrados (antes y después)
  perform bloquear_existencias((
    select coalesce(jsonb_agg(distinct jsonb_build_object('producto_id', pid, 'almacen_id', v.almacen_id)), '[]')
      from (select producto_id pid from venta_partidas where venta_id = v.id
            union select (e->>'producto_id')::uuid from jsonb_array_elements(p->'partidas') e) t
      join productos pp on pp.id = t.pid where pp.tipo = 'producto'));

  -- Cantidad base anterior por producto
  create temp table if not exists _antes (producto_id uuid primary key, cb numeric) on commit drop;
  delete from _antes;
  insert into _antes select producto_id, sum(cantidad_base) from venta_partidas where venta_id = v.id group by producto_id;

  -- Renglones existentes que se quitan
  for vp in select * from venta_partidas where venta_id = v.id loop
    if not exists (select 1 from jsonb_array_elements(p->'partidas') e where nullif(e->>'partida_id','')::uuid = vp.id) then
      perform exigir(vp.cantidad_entregada = 0, format('No se puede quitar el renglón %s: ya se entregó material', vp.renglon));
      delete from costo_pendiente where venta_partida_id = vp.id;
      delete from venta_partidas where id = vp.id;
    end if;
  end loop;

  -- Renglones nuevos o modificados (se renumeran en el orden recibido)
  update venta_partidas set renglon = renglon + 1000 where venta_id = v.id;
  v_ren := 0;
  for x in select * from jsonb_array_elements(p->'partidas') loop
    v_ren := v_ren + 1;
    select * into u from unidades_venta where id = (x->>'unidad_venta_id')::uuid;
    select * into pr from productos where id = u.producto_id;
    perform exigir(u.id is not null and pr.id = (x->>'producto_id')::uuid, 'Producto o unidad inválidos');
    v_cant := (x->>'cantidad')::numeric; v_precio := (x->>'precio_unitario')::numeric; v_desc := coalesce(nullif(x->>'descuento','')::numeric, 0);
    perform exigir(v_cant > 0, pr.nombre || ': la cantidad debe ser mayor a cero');
    v_cb := cantidad_base_de(v_cant, u.factor, pr.permite_fraccion, pr.nombre);
    v_iva := case when v.sin_iva then 0 else pr.iva_tasa end;
    select * into c from calcular_partida(v_cant, v_precio, v_desc, v_iva, pr.ieps_tasa, v_incl);
    select precio into v_lista_precio from precios where lista_id = v.lista_id and unidad_venta_id = u.id;

    v_pid := nullif(x->>'partida_id','')::uuid;
    if v_pid is not null then
      select * into vp from venta_partidas where id = v_pid and venta_id = v.id;
      perform exigir(vp.id is not null, 'Renglón no encontrado en la venta');
      perform exigir(vp.cantidad_entregada = 0 or vp.unidad_venta_id = u.id, pr.nombre || ': no se puede cambiar la unidad de un renglón ya entregado');
      perform exigir(v_cant >= vp.cantidad_entregada, format('%s: no puedes dejar menos de lo ya entregado (%s %s)', pr.nombre, vp.cantidad_entregada, vp.unidad_nombre));
      perform exigir(v_precio = vp.precio_unitario or v_precio = v_lista_precio or tiene_permiso('modificar_precios'), pr.nombre || ': no tienes permiso para cambiar el precio');
      perform exigir(v_desc <= vp.descuento or tiene_permiso('aplicar_descuentos'), pr.nombre || ': no tienes permiso para aplicar descuentos');
      update venta_partidas set renglon = v_ren, unidad_venta_id = u.id, unidad_nombre = u.nombre, factor = u.factor,
             cantidad = v_cant, cantidad_base = v_cb, precio_unitario = v_precio, descuento = v_desc,
             iva_tasa = v_iva, subtotal = c.subtotal, ieps = c.ieps, iva = c.iva, total = c.total,
             comentario = nullif(trim(x->>'comentario'), '')
       where id = vp.id;
    else
      perform exigir(pr.activo, pr.nombre || ': el producto está inactivo');
      perform exigir(v_precio = v_lista_precio or tiene_permiso('modificar_precios'), pr.nombre || ': no tienes permiso para cambiar el precio');
      perform exigir(v_desc = 0 or tiene_permiso('aplicar_descuentos'), pr.nombre || ': no tienes permiso para aplicar descuentos');
      v_costo := coalesce(costo_venta(pr.id), 0);
      insert into venta_partidas (venta_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
        cantidad_base, cantidad_entregada, precio_unitario, precio_lista, descuento, iva_tasa, ieps_tasa,
        subtotal, ieps, iva, total, costo_unitario_base, comentario)
      values (v.id, v_ren, pr.id, u.id, u.nombre, u.factor, v_cant, v_cb,
        case when coalesce((x->>'entregar_ahora')::boolean, true) then v_cant else 0 end, v_precio, v_lista_precio, v_desc,
        v_iva, pr.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, v_costo, nullif(trim(x->>'comentario'), ''));
    end if;
    t_sub := t_sub + c.subtotal; t_desc := t_desc + v_desc; t_ieps := t_ieps + c.ieps; t_iva := t_iva + c.iva; t_tot := t_tot + c.total;
  end loop;

  -- Inventario: diferencia neta por producto (mismo documento, tipo 'venta')
  for r in select coalesce(n.producto_id, a.producto_id) producto_id, coalesce(n.cb, 0) - coalesce(a.cb, 0) delta
             from (select producto_id, sum(cantidad_base) cb from venta_partidas where venta_id = v.id group by producto_id) n
             full join _antes a on a.producto_id = n.producto_id
  loop
    continue when r.delta = 0;
    select * into pr from productos where id = r.producto_id;
    continue when pr.tipo <> 'producto';
    v_costo := coalesce(costo_venta(pr.id), 0);
    v_antes := mover_inventario(pr.id, v.almacen_id, -r.delta, 'venta', 'venta', v.id, v_costo, 'Edición de la venta');
    if r.delta > 0 and v_antes < r.delta then
      v_falt := r.delta - greatest(v_antes, 0);
      update venta_partidas set vendida_sin_existencia = true, faltante_base = coalesce(faltante_base, 0) + v_falt
       where id = (select id from venta_partidas where venta_id = v.id and producto_id = pr.id order by renglon desc limit 1);
    end if;
  end loop;

  -- Totales, pagos y diferencia
  v_pagado := v.pagado;
  if v_pagado > t_tot then
    v_exceso := v_pagado - t_tot;
    if p->>'diferencia' = 'saldo_favor' then
      perform exigir(not v_cli.es_publico_general, 'Para dejar saldo a favor la venta debe tener un cliente registrado');
      perform mover_saldo_favor(v_cli.id, v_exceso, v.id, format('Ajuste por edición de la venta %s%s', v.serie, v.folio));
    elsif p->>'diferencia' = 'devolver' then
      perform exigir(coalesce(p->>'devolucion_forma','') in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Indica cómo se devuelve el dinero');
      insert into venta_devoluciones (venta_id, forma, importe, motivo, usuario_id)
      values (v.id, p->>'devolucion_forma', v_exceso, 'Edición de la venta', auth.uid());
    else
      raise exception 'El nuevo total (%) es menor a lo pagado (%): indica si la diferencia de % se devuelve o queda a favor', t_tot, v_pagado, v_exceso;
    end if;
    v_pagado := t_tot;
  end if;
  v_saldo := t_tot - v_pagado;

  update ventas set subtotal = t_sub, descuento = t_desc, ieps = t_ieps, iva = t_iva, total = t_tot,
                    pagado = v_pagado, saldo = v_saldo,
                    comentarios = case when p ? 'comentarios' then nullif(trim(p->>'comentarios'), '') else comentarios end,
                    orden_compra = case when p ? 'orden_compra' then nullif(trim(p->>'orden_compra'), '') else orden_compra end,
                    con_faltante = exists (select 1 from venta_partidas where venta_id = v.id and vendida_sin_existencia),
                    editada_en = now(), ediciones = ediciones + 1
   where id = v.id;

  perform registrar_bitacora('editar', 'ventas', v.id::text, v_antes_json,
    jsonb_build_object('clave', v_key, 'total', t_tot, 'exceso', v_exceso, 'diferencia', p->>'diferencia',
      'partidas', (select jsonb_agg(jsonb_build_object('producto_id', producto_id, 'unidad', unidad_nombre, 'cantidad', cantidad, 'precio', precio_unitario, 'descuento', descuento) order by renglon)
                     from venta_partidas where venta_id = v.id)));
  return jsonb_build_object('venta_id', v.id, 'total', t_tot, 'saldo', v_saldo, 'exceso', v_exceso, 'repetida', false);
end $$;

-- Cerrar venta: queda terminada (ya no se edita)
create or replace function public.cerrar_venta(p_venta uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas%rowtype;
begin
  select * into v from ventas where id = p_venta for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes cerrar ventas de esta sucursal');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');
  perform exigir(not v.cerrada, 'La venta ya está cerrada');
  update ventas set cerrada = true, cerrada_en = now(), cerrada_por = auth.uid() where id = v.id;
  perform registrar_bitacora('cerrar', 'ventas', v.id::text, null, null);
end $$;

-- Historial de cambios de una venta (para la pestaña Actividades)
create or replace function public.historial_venta(p_venta uuid)
returns table (fecha timestamptz, accion text, usuario text, detalle jsonb)
language sql stable security definer set search_path = public as $$
  select b.fecha, b.accion, coalesce(pf.nombre, ''), coalesce(b.despues, '{}'::jsonb) || jsonb_build_object('antes', b.antes)
    from bitacora b left join perfiles pf on pf.user_id = b.user_id
   where b.entidad = 'ventas' and b.entidad_id = p_venta::text
     and exists (select 1 from ventas v where v.id = p_venta and opera_sucursal(v.sucursal_id))
   order by b.fecha;
$$;

revoke execute on function public.editar_venta(jsonb), public.cerrar_venta(uuid), public.historial_venta(uuid) from public, anon;
grant execute on function public.editar_venta(jsonb), public.cerrar_venta(uuid), public.historial_venta(uuid) to authenticated;


-- confirmar_venta: acepta la forma de pago 'saldo_favor' (descuenta el saldo a favor del cliente)
create or replace function public.confirmar_venta(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p->>'idempotency_key';
  v_ex ventas%rowtype;
  v_al almacenes%rowtype;
  v_suc uuid := (p->>'sucursal_id')::uuid;
  v_cli clientes%rowtype;
  v_lista uuid; v_incl boolean;
  v_tipo text := coalesce(p->>'tipo', 'contado');
  v_cot cotizaciones%rowtype;
  v_apa apartados%rowtype;
  v_id uuid := gen_random_uuid(); v_serie text; v_folio bigint;
  r record; c record; v_ren int := 0; v_cb numeric; v_antes numeric; v_costo numeric; v_falt numeric;
  v_pid uuid; v_precio_lista numeric; v_precio_cot numeric; v_desc_cot numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
  v_pagos numeric := 0; v_no_efectivo numeric := 0; v_anticipo numeric := 0; v_cambio numeric := 0; v_saldo numeric := 0;
  v_sc record; v_avisos jsonb := '[]';
  -- Remisión sin IVA (predeterminado): el precio es el importe final y la tasa de IVA queda en 0
  v_sin_iva boolean := coalesce((p->>'sin_iva')::boolean, true);
  v_iva_tasa numeric;
  -- Contado con abono: el cliente deja un abono (o nada) y el resto queda como saldo pendiente
  v_abono boolean := coalesce((p->>'pago_pendiente')::boolean, false);
begin
  perform exigir(v_key is not null and length(v_key) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('venta:' || v_key, 0));
  select * into v_ex from ventas where idempotency_key = v_key;
  if v_ex.id is not null then
    return jsonb_build_object('venta_id', v_ex.id, 'serie', v_ex.serie, 'folio', v_ex.folio,
                              'total', v_ex.total, 'cambio', v_ex.cambio, 'repetida', true, 'avisos', '[]'::jsonb);
  end if;

  perform exigir(opera_sucursal(v_suc), 'No puedes vender en esta sucursal');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and v_al.activo, 'Almacén no válido');
  perform exigir(v_al.sucursal_id = v_suc or v_al.multisucursal, 'El almacén no pertenece a la sucursal');
  perform exigir(opera_almacen(v_al.id), 'No puedes vender desde este almacén');

  if nullif(p->>'cliente_id','') is null then
    select * into v_cli from clientes where es_publico_general;
  else
    select * into v_cli from clientes where id = (p->>'cliente_id')::uuid;
  end if;
  perform exigir(v_cli.id is not null and v_cli.activo, 'Cliente no válido');

  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, v_cli.id);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;
  perform exigir(v_lista is not null, 'No hay lista de precios');

  if nullif(p->>'cotizacion_id','') is not null then
    select * into v_cot from cotizaciones where id = (p->>'cotizacion_id')::uuid for update;
    perform exigir(v_cot.id is not null, 'Cotización no encontrada');
    perform exigir(v_cot.estado in ('borrador','enviada'), 'La cotización ya está ' || v_cot.estado);
  end if;

  if nullif(p->>'apartado_id','') is not null then
    select * into v_apa from apartados where id = (p->>'apartado_id')::uuid for update;
    perform exigir(v_apa.id is not null, 'Apartado no encontrado');
    perform exigir(v_apa.estado = 'abierto', 'El apartado ya está ' || v_apa.estado);
    perform exigir(v_apa.cliente_id = v_cli.id, 'El cliente no coincide con el del apartado');
    perform exigir(v_apa.almacen_id = v_al.id, 'La venta debe salir del almacén donde se apartó');
  end if;

  perform bloquear_existencias((
    select coalesce(jsonb_agg(jsonb_build_object('producto_id', pr.id, 'almacen_id', v_al.id)), '[]')
      from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
     where pr.tipo = 'producto'));

  -- Libera la reserva del apartado antes de descontar
  if v_apa.id is not null then
    for r in select ap.producto_id, sum(ap.cantidad_base) cb from apartado_partidas ap join productos pr on pr.id = ap.producto_id
              where ap.apartado_id = v_apa.id and pr.tipo = 'producto' group by ap.producto_id loop
      perform bloquear_existencias(jsonb_build_array(jsonb_build_object('producto_id', r.producto_id, 'almacen_id', v_al.id)));
      update existencias set apartado = apartado - r.cb, actualizado_en = now() where producto_id = r.producto_id and almacen_id = v_al.id;
    end loop;
  end if;

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'venta') s;

  insert into ventas (id, sucursal_id, almacen_id, caja_id, serie, folio, cliente_id, vendedor_id, lista_id, tipo,
                      subtotal, descuento, ieps, iva, total, cotizacion_id, apartado_id, comentarios, idempotency_key, sin_iva, orden_compra, con_abono)
  values (v_id, v_suc, v_al.id, nullif(p->>'caja_id','')::uuid, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, v_tipo,
          0, 0, 0, 0, 0, v_cot.id, v_apa.id, p->>'comentarios', v_key, v_sin_iva, nullif(trim(p->>'orden_compra'), ''), v_tipo = 'contado' and v_abono);

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce((x->>'descuento')::numeric, 0) descuento,
                  coalesce((x->>'entregar_ahora')::boolean, true) entregar_ahora, nullif(trim(x->>'comentario'), '') comentario,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.tipo, pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre
             from jsonb_array_elements(p->'partidas') x
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo, 'Producto o unidad inválidos');
    perform exigir(r.cantidad > 0, 'La cantidad debe ser mayor a cero');

    -- Precio aceptado: lista, cotizado, apartado (congelado) o con permiso
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    v_precio_cot := null; v_desc_cot := 0;
    if v_cot.id is not null then
      select precio_unitario, descuento into v_precio_cot, v_desc_cot from cotizacion_partidas
       where cotizacion_id = v_cot.id and unidad_venta_id = r.unidad_id order by renglon limit 1;
    elsif v_apa.id is not null then
      select precio_unitario, descuento into v_precio_cot, v_desc_cot from apartado_partidas
       where apartado_id = v_apa.id and unidad_venta_id = r.unidad_id order by renglon limit 1;
    end if;
    perform exigir(r.precio = v_precio_lista or r.precio = v_precio_cot or tiene_permiso('modificar_precios'),
                   r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or r.descuento <= coalesce(v_desc_cot, 0) or tiene_permiso('aplicar_descuentos'),
                   r.producto_nombre || ': no tienes permiso para aplicar descuentos');

    v_ren := v_ren + 1;
    v_iva_tasa := case when v_sin_iva then 0 else r.iva_tasa end;
    v_cb := cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre);
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, v_iva_tasa, r.ieps_tasa, v_incl);
    v_costo := coalesce(costo_venta(r.producto_id), 0);

    insert into venta_partidas (venta_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, cantidad_entregada, precio_unitario, precio_lista, descuento, iva_tasa, ieps_tasa,
      subtotal, ieps, iva, total, costo_unitario_base, comentario)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, v_cb,
      case when r.entregar_ahora then r.cantidad else 0 end, r.precio, v_precio_lista, r.descuento,
      v_iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, v_costo, r.comentario)
    returning id into v_pid;

    if r.tipo = 'producto' then
      v_antes := mover_inventario(r.producto_id, v_al.id, -v_cb, 'venta', 'venta', v_id, v_costo);
      if v_antes < v_cb then
        v_falt := v_cb - greatest(v_antes, 0);
        update venta_partidas set vendida_sin_existencia = true, faltante_base = v_falt where id = v_pid;
        insert into costo_pendiente (producto_id, almacen_id, venta_partida_id, cantidad_pendiente, costo_usado)
        values (r.producto_id, v_al.id, v_pid, v_falt, v_costo);
        v_avisos := v_avisos || jsonb_build_object('renglon', v_ren, 'producto', r.producto_nombre,
                      'mensaje', 'Vendida sin existencia suficiente', 'faltante_base', v_falt);
      end if;
    end if;

    t_sub := t_sub + c.subtotal; t_desc := t_desc + r.descuento; t_ieps := t_ieps + c.ieps;
    t_iva := t_iva + c.iva; t_tot := t_tot + c.total;
  end loop;
  perform exigir(v_ren > 0, 'La venta no tiene partidas');

  for r in select x->>'forma' forma, (x->>'importe')::numeric importe, x->>'referencia' referencia
             from jsonb_array_elements(coalesce(p->'pagos', '[]')) x
  loop
    perform exigir(r.importe > 0, 'Importe de pago inválido');
    if r.forma = 'saldo_favor' then
      perform exigir(not v_cli.es_publico_general, 'El saldo a favor solo aplica a clientes registrados');
      perform mover_saldo_favor(v_cli.id, -r.importe, v_id, format('Pago de la venta %s%s', v_serie, v_folio));
    end if;
    if r.forma = 'anticipo' then
      perform exigir(v_apa.id is not null, 'La forma "anticipo" solo aplica al liquidar un apartado');
      v_anticipo := v_anticipo + r.importe;
    end if;
    insert into venta_pagos (venta_id, forma, importe, referencia) values (v_id, r.forma, r.importe, r.referencia);
    v_pagos := v_pagos + r.importe;
    if r.forma <> 'efectivo' then v_no_efectivo := v_no_efectivo + r.importe; end if;
  end loop;
  perform exigir(v_no_efectivo <= t_tot, 'Los pagos con tarjeta, transferencia o anticipo exceden el total');
  if v_apa.id is not null then
    perform exigir(v_anticipo = v_apa.abonado, format('Debe aplicarse el anticipo completo del apartado (%s)', v_apa.abonado));
  end if;

  if v_tipo = 'contado' and v_abono then
    perform exigir(not v_cli.es_publico_general, 'Para dejar saldo pendiente elige o da de alta al cliente');
    perform exigir(v_pagos <= t_tot, 'El abono excede el total de la venta');
    v_cambio := 0;
    v_saldo := t_tot - v_pagos;
  elsif v_tipo = 'contado' then
    perform exigir(v_pagos >= t_tot, 'El pago no cubre el total de la venta');
    v_cambio := v_pagos - t_tot;
    v_saldo := 0;
    if v_cambio > 0 then
      update venta_pagos set importe = importe - v_cambio
       where id = (select id from venta_pagos where venta_id = v_id and forma = 'efectivo' order by importe desc limit 1);
    end if;
  else
    perform exigir(not v_cli.es_publico_general, 'La venta a crédito requiere un cliente');
    perform exigir(v_pagos <= t_tot, 'El anticipo excede el total');
    v_saldo := t_tot - v_pagos;
    select * into v_sc from saldo_cliente(v_cli.id);
    perform exigir(not v_cli.bloqueado or tiene_permiso('otorgar_credito'), 'El cliente está bloqueado para crédito');
    perform exigir(v_sc.vencido = 0 or tiene_permiso('otorgar_credito'), 'El cliente tiene saldo vencido');
    perform exigir(v_sc.saldo + v_saldo <= v_cli.limite_credito or tiene_permiso('otorgar_credito'),
                   'La venta excede el límite de crédito del cliente');
  end if;

  update ventas set subtotal = t_sub, descuento = t_desc, ieps = t_ieps, iva = t_iva, total = t_tot,
                    pagado = least(v_pagos, t_tot), saldo = v_saldo, cambio = v_cambio,
                    vencimiento = case when v_tipo = 'credito'
                                       then (now() at time zone 'America/Mexico_City')::date + v_cli.dias_credito end,
                    con_faltante = jsonb_array_length(v_avisos) > 0
   where id = v_id;

  if v_cot.id is not null then
    update cotizaciones set estado = 'convertida', venta_id = v_id where id = v_cot.id;
  end if;
  if v_apa.id is not null then
    update apartados set estado = 'liquidado', venta_id = v_id, saldo = 0 where id = v_apa.id;
  end if;

  return jsonb_build_object('venta_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', t_tot,
                            'cambio', v_cambio, 'saldo', v_saldo, 'repetida', false, 'avisos', v_avisos);
end $$;

-- cancelar_venta: devuelve al cliente el saldo a favor usado
create or replace function public.cancelar_venta(p_venta uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas%rowtype; m record;
begin
  select * into v from ventas where id = p_venta for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes cancelar ventas de esta sucursal');
  perform exigir(tiene_permiso('cancelar_ventas'), 'No tienes permiso para cancelar ventas');
  perform exigir(v.estado = 'confirmada', 'La venta ya está cancelada');
  perform exigir(length(trim(coalesce(p_motivo,''))) > 0, 'El motivo es obligatorio');
  perform exigir(v.factura_uuid is null, 'La venta está facturada: cancela el CFDI o emite nota de crédito primero');

  perform bloquear_existencias((select coalesce(jsonb_agg(jsonb_build_object('producto_id', producto_id, 'almacen_id', almacen_id)), '[]')
                                  from movimientos where documento_tipo = 'venta' and documento_id = v.id));
  for m in select producto_id, almacen_id, cantidad, costo_unitario from movimientos
            where documento_tipo = 'venta' and documento_id = v.id and tipo = 'venta' order by id
  loop
    perform mover_inventario(m.producto_id, m.almacen_id, -m.cantidad, 'cancelacion_venta', 'venta', v.id,
                             m.costo_unitario, p_motivo);
  end loop;

  -- El saldo a favor que se usó para pagar esta venta regresa al cliente
  if exists (select 1 from venta_pagos where venta_id = v.id and forma = 'saldo_favor') then
    perform mover_saldo_favor(v.cliente_id, (select sum(importe) from venta_pagos where venta_id = v.id and forma = 'saldo_favor'), v.id,
                              format('Cancelación de la venta %s%s', v.serie, v.folio));
  end if;

  update costo_pendiente set cantidad_pendiente = 0
   where venta_partida_id in (select id from venta_partidas where venta_id = v.id);
  update ventas set estado = 'cancelada', saldo = 0, cancelada_en = now(), cancelada_por = auth.uid(),
                    motivo_cancelacion = p_motivo
   where id = v.id;
  if v.cotizacion_id is not null then
    -- La cotización queda ligada a una venta cancelada; no se reabre automáticamente
    null;
  end if;
  perform registrar_bitacora('cancelar', 'ventas', v.id::text, to_jsonb(v), jsonb_build_object('motivo', p_motivo));
end $$;
