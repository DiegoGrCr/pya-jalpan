-- =============================================================================
-- 0038 · Cartera de clientes (saldo a favor) y devolución de productos
-- - El saldo a favor solo cambia con movimientos registrados (no se edita directo).
-- - abonar_saldo_favor: el cliente deja dinero para una compra futura (forma, referencia).
-- - confirmar_venta: "cambio_a_favor" deja el cambio como saldo a favor en lugar de entregarlo.
-- - devolver_productos: regresa material entregado de una venta (aunque esté cerrada): vuelve al
--   inventario y el importe queda como saldo a favor o se devuelve en dinero. La venta queda cerrada
--   y ya no se puede cancelar (para no regresar dos veces el material).
-- Requiere 0027 y 0028. Se puede ejecutar más de una vez.
-- =============================================================================

-- El saldo a favor solo se modifica desde las funciones del sistema (que corren como su dueño)
create or replace function public.trg_proteger_saldo_favor()
returns trigger language plpgsql as $$
begin
  if new.saldo_a_favor is distinct from coalesce(old.saldo_a_favor, 0) and current_user in ('authenticated', 'anon') then
    raise exception 'El saldo a favor solo cambia con abonos, devoluciones o pagos registrados';
  end if;
  return new;
end $$;
drop trigger if exists proteger_saldo_favor on public.clientes;
create trigger proteger_saldo_favor before insert or update of saldo_a_favor on public.clientes
  for each row execute function public.trg_proteger_saldo_favor();

alter table public.saldo_favor_movimientos add column if not exists forma           text;
alter table public.saldo_favor_movimientos add column if not exists referencia      text;
alter table public.saldo_favor_movimientos add column if not exists idempotency_key text unique;
alter table public.venta_partidas          add column if not exists cantidad_devuelta numeric(18,6) not null default 0;

create table if not exists public.devoluciones_producto (
  id         uuid primary key default gen_random_uuid(),
  venta_id   uuid not null references public.ventas(id),
  fecha      timestamptz not null default now(),
  usuario_id uuid,
  destino    text not null check (destino in ('saldo_favor', 'dinero')),
  forma      text check (forma in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito')),
  importe    numeric(14,2) not null check (importe > 0),
  motivo     text not null,
  partidas   jsonb not null,
  idempotency_key text unique
);
alter table public.devoluciones_producto enable row level security;
drop policy if exists devoluciones_producto_sel on public.devoluciones_producto;
create policy devoluciones_producto_sel on public.devoluciones_producto for select to authenticated
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.opera_sucursal(v.sucursal_id)));
grant select on public.devoluciones_producto to authenticated;

-- {cliente_id, importe, forma, referencia?, concepto?, idempotency_key}
create or replace function public.abonar_saldo_favor(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cli clientes%rowtype; v_imp numeric := round(nullif(p->>'importe','')::numeric, 2); v_saldo numeric; v_id uuid;
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('favor:' || (p->>'idempotency_key'), 0));
  select id, saldo into v_id, v_saldo from saldo_favor_movimientos where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('movimiento_id', v_id, 'saldo', v_saldo, 'repetida', true); end if;
  perform exigir(exists (select 1 from perfiles where user_id = auth.uid() and activo), 'Usuario no autorizado');
  select * into v_cli from clientes where id = (p->>'cliente_id')::uuid;
  perform exigir(v_cli.id is not null and not v_cli.es_publico_general, 'Elige un cliente registrado');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');
  perform exigir(p->>'forma' in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Forma de pago no válida');
  v_saldo := mover_saldo_favor(v_cli.id, v_imp, null, coalesce(nullif(trim(p->>'concepto'), ''), 'Abono a saldo a favor'));
  update saldo_favor_movimientos set forma = p->>'forma', referencia = nullif(trim(p->>'referencia'), ''), idempotency_key = p->>'idempotency_key'
   where id = (select id from saldo_favor_movimientos where cliente_id = v_cli.id order by fecha desc, id desc limit 1)
  returning id into v_id;
  return jsonb_build_object('movimiento_id', v_id, 'saldo', v_saldo, 'repetida', false);
end $$;

-- {venta_id, idempotency_key, motivo, destino: 'saldo_favor'|'dinero', forma?, partidas:[{partida_id, cantidad}]}
create or replace function public.devolver_productos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v ventas%rowtype; v_cli clientes%rowtype; x jsonb; vp venta_partidas%rowtype; pr productos%rowtype;
  v_cant numeric; v_cb numeric; v_imp numeric := 0; v_i numeric; v_det jsonb := '[]'; v_id uuid;
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('devolucion:' || (p->>'idempotency_key'), 0));
  select id into v_id from devoluciones_producto where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('devolucion_id', v_id, 'repetida', true); end if;

  select * into v from ventas where id = (p->>'venta_id')::uuid for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes registrar devoluciones de esta sucursal');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'Indica el motivo de la devolución');
  perform exigir(p->>'destino' in ('saldo_favor', 'dinero'), 'Indica si el importe queda a favor o se devuelve');
  select * into v_cli from clientes where id = v.cliente_id;
  perform exigir(p->>'destino' = 'dinero' or not v_cli.es_publico_general, 'Para dejar saldo a favor la venta debe ser de un cliente registrado');
  perform exigir(p->>'destino' = 'saldo_favor' or p->>'forma' in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Indica cómo se devuelve el dinero');

  for x in select * from jsonb_array_elements(coalesce(p->'partidas', '[]')) loop
    v_cant := nullif(x->>'cantidad','')::numeric;
    continue when v_cant is null or v_cant = 0;
    select * into vp from venta_partidas where id = (x->>'partida_id')::uuid and venta_id = v.id for update;
    perform exigir(vp.id is not null, 'Renglón no encontrado en la venta');
    select * into pr from productos where id = vp.producto_id;
    perform exigir(v_cant > 0, pr.nombre || ': cantidad no válida');
    perform exigir(v_cant <= vp.cantidad_entregada - vp.cantidad_devuelta,
                   format('%s: solo puedes devolver lo entregado y no devuelto (%s %s)', pr.nombre, vp.cantidad_entregada - vp.cantidad_devuelta, vp.unidad_nombre));
    v_cb := cantidad_base_de(v_cant, vp.factor, pr.permite_fraccion, pr.nombre);
    v_i := round(vp.total * v_cant / vp.cantidad, 2);
    if pr.tipo = 'producto' then
      perform bloquear_existencias(jsonb_build_array(jsonb_build_object('producto_id', pr.id, 'almacen_id', coalesce(vp.almacen_id, v.almacen_id))));
      perform mover_inventario(pr.id, coalesce(vp.almacen_id, v.almacen_id), v_cb, 'devolucion', 'venta', v.id, vp.costo_unitario_base,
                               'Devolución: ' || trim(p->>'motivo'));
    end if;
    update venta_partidas set cantidad_devuelta = cantidad_devuelta + v_cant where id = vp.id;
    v_imp := v_imp + v_i;
    v_det := v_det || jsonb_build_object('partida_id', vp.id, 'producto', pr.nombre, 'unidad', vp.unidad_nombre, 'cantidad', v_cant, 'importe', v_i);
  end loop;
  perform exigir(v_imp > 0, 'Indica qué productos y cuántos se devuelven');

  if p->>'destino' = 'saldo_favor' then
    perform mover_saldo_favor(v_cli.id, v_imp, v.id, format('Devolución de productos de la venta %s %s', v.serie, v.folio));
  else
    insert into venta_devoluciones (venta_id, forma, importe, motivo, usuario_id) values (v.id, p->>'forma', v_imp, 'Devolución de productos', auth.uid());
  end if;
  insert into devoluciones_producto (venta_id, usuario_id, destino, forma, importe, motivo, partidas, idempotency_key)
  values (v.id, auth.uid(), p->>'destino', case when p->>'destino' = 'dinero' then p->>'forma' end, v_imp, trim(p->>'motivo'), v_det, p->>'idempotency_key')
  returning id into v_id;
  -- La venta queda cerrada: ya no se edita (el material devuelto ya regresó al inventario)
  update ventas set cerrada = true, cerrada_en = coalesce(cerrada_en, now()), cerrada_por = coalesce(cerrada_por, auth.uid()) where id = v.id;
  perform registrar_bitacora('devolucion', 'ventas', v.id::text, null,
                             jsonb_build_object('importe', v_imp, 'destino', p->>'destino', 'forma', p->>'forma', 'motivo', p->>'motivo', 'partidas', v_det));
  return jsonb_build_object('devolucion_id', v_id, 'importe', v_imp, 'repetida', false);
end $$;

revoke execute on function public.abonar_saldo_favor(jsonb), public.devolver_productos(jsonb) from public, anon;
grant execute on function public.abonar_saldo_favor(jsonb), public.devolver_productos(jsonb) to authenticated;


-- confirmar_venta: cambio_a_favor
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

  -- Cada renglón puede salir de otro almacén (bodega); por omisión, el de la venta
  perform exigir(not exists (select 1 from jsonb_array_elements(p->'partidas') x
                              left join almacenes a on a.id = nullif(x->>'almacen_id','')::uuid
                             where nullif(x->>'almacen_id','') is not null and (a.id is null or not a.activo)),
                 'Almacén de renglón no válido');
  perform bloquear_existencias((
    select coalesce(jsonb_agg(distinct jsonb_build_object('producto_id', pr.id, 'almacen_id', coalesce(nullif(x->>'almacen_id','')::uuid, v_al.id))), '[]')
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
                  coalesce(nullif(x->>'almacen_id','')::uuid, v_al.id) almacen_id,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.tipo, pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre
             from (select value as x, ordinality as n from jsonb_array_elements(p->'partidas') with ordinality) e
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
            order by e.n   -- los renglones conservan el orden en que se capturaron
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
      subtotal, ieps, iva, total, costo_unitario_base, comentario, almacen_id)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, v_cb,
      case when r.entregar_ahora then r.cantidad else 0 end, r.precio, v_precio_lista, r.descuento,
      v_iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, v_costo, r.comentario, r.almacen_id)
    returning id into v_pid;

    if r.tipo = 'producto' then
      v_antes := mover_inventario(r.producto_id, r.almacen_id, -v_cb, 'venta', 'venta', v_id, v_costo);
      if v_antes < v_cb then
        v_falt := v_cb - greatest(v_antes, 0);
        update venta_partidas set vendida_sin_existencia = true, faltante_base = v_falt where id = v_pid;
        insert into costo_pendiente (producto_id, almacen_id, venta_partida_id, cantidad_pendiente, costo_usado)
        values (r.producto_id, r.almacen_id, v_pid, v_falt, v_costo);
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
    -- El cliente deja el cambio como saldo a favor (el dinero se queda completo en caja)
    if v_cambio > 0 and coalesce((p->>'cambio_a_favor')::boolean, false) then
      perform exigir(not v_cli.es_publico_general, 'Para dejar el cambio a favor elige o da de alta al cliente');
      perform mover_saldo_favor(v_cli.id, v_cambio, v_id, format('Cambio dejado a favor en la venta %s %s', v_serie, v_folio));
      v_cambio := 0;
    end if;
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

-- cancelar_venta: no se cancela una venta con devoluciones
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
  perform exigir(not exists (select 1 from devoluciones_producto where venta_id = v.id),
                 'La venta tiene devoluciones registradas; ya no se puede cancelar');

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

-- Clientes con su cartera: lo que deben (ventas con saldo de sus sucursales) y su saldo a favor.
-- p: {texto?, filtro?: 'debe'|'favor', limite?, desplazamiento?}
create or replace function public.clientes_cartera(p jsonb)
returns table (id uuid, nombre text, razon_social text, rfc text, telefono text, correo_facturas text, saldo_a_favor numeric,
               por_cobrar numeric, ventas_con_saldo bigint, ultima_compra timestamptz, total_filas bigint)
language sql stable security invoker set search_path = public as $$
  with par as (select nullif(trim(p->>'texto'), '') t, coalesce(p->>'filtro', '') f,
                      least(coalesce(nullif(p->>'limite','')::int, 50), 2000) lim, coalesce(nullif(p->>'desplazamiento','')::int, 0) desp),
  base as (
    select c.id, c.nombre, c.razon_social, c.rfc, c.telefono, c.correo_facturas, c.saldo_a_favor,
           coalesce((select sum(v.saldo) from ventas v where v.cliente_id = c.id and v.estado = 'confirmada' and v.saldo > 0), 0) por_cobrar,
           (select count(*) from ventas v where v.cliente_id = c.id and v.estado = 'confirmada' and v.saldo > 0) ventas_con_saldo,
           (select max(v.fecha) from ventas v where v.cliente_id = c.id and v.estado = 'confirmada') ultima_compra
      from clientes c, par
     where c.activo and not c.es_publico_general
       and (par.t is null or c.nombre ilike '%' || par.t || '%' or c.razon_social ilike '%' || par.t || '%'
            or c.rfc ilike '%' || par.t || '%' or c.telefono ilike '%' || par.t || '%')
  )
  select b.*, count(*) over () from base b, par
   where case par.f when 'debe' then b.por_cobrar > 0 when 'favor' then b.saldo_a_favor > 0 else true end
   order by b.nombre
   limit (select lim from par) offset (select desp from par);
$$;
revoke execute on function public.clientes_cartera(jsonb) from public, anon;
grant execute on function public.clientes_cartera(jsonb) to authenticated;
