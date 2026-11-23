-- =============================================================================
-- Apartados: reglas definidas por el negocio (23-nov-2026)
--  * Sin anticipo mínimo: se puede apartar "a palabra" (anticipo 0).
--  * Aviso a los 15 días abierto (no se cancela solo).
--  * Precio congelado al apartar (sin cambio).
--  * Al cancelar, quien cancela decide cuánto retener (de 0 a lo abonado) y si el resto se devuelve
--    en dinero o queda como saldo a favor del cliente.
--  * Como en ventas: remisión sin IVA (sin_iva), conceptos genéricos (descripcion) y comentario por renglón.
-- Se puede ejecutar más de una vez.
-- =============================================================================
begin;

update public.empresa set apartado_anticipo_minimo = 0, apartado_dias_aviso = 15 where id = 1;
alter table public.empresa alter column apartado_anticipo_minimo set default 0;
alter table public.empresa alter column apartado_dias_aviso set default 15;

-- Toda sucursal activa con serie de apartados (código + P), por si se creó sin ella
insert into public.series (sucursal_id, tipo_documento, prefijo)
select su.id, 'apartado', su.codigo || 'P' from public.sucursales su
 where not exists (select 1 from public.series se where se.sucursal_id = su.id and se.tipo_documento = 'apartado');

alter table public.apartados add column if not exists sin_iva boolean not null default true;
alter table public.apartados add column if not exists cancelacion_destino text check (cancelacion_destino in ('dinero','saldo_favor'));
alter table public.apartado_partidas add column if not exists descripcion text;
alter table public.apartado_partidas add column if not exists comentario text;

-- La vista toma las columnas nuevas
drop view if exists public.v_apartados;
create view public.v_apartados with (security_invoker = true) as
select a.*,
  ((now() at time zone 'America/Mexico_City')::date - (a.fecha at time zone 'America/Mexico_City')::date) as dias_abierto,
  (a.estado = 'abierto' and (now() at time zone 'America/Mexico_City')::date
     - (a.fecha at time zone 'America/Mexico_City')::date >= (select apartado_dias_aviso from public.empresa where id = 1)) as requiere_aviso
from public.apartados a;
grant select on public.v_apartados to authenticated;

create or replace function public.crear_apartado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p->>'idempotency_key'; v_ex apartados%rowtype; v_al almacenes%rowtype;
  v_suc uuid := (p->>'sucursal_id')::uuid; v_cli clientes%rowtype; v_lista uuid; v_incl boolean;
  v_id uuid := gen_random_uuid(); v_serie text; v_folio bigint; r record; c record; v_ren int := 0;
  v_precio_lista numeric; v_ant numeric := 0; v_min numeric;
  -- Remisión sin IVA (como en ventas): el precio es el importe final
  v_sin_iva boolean := coalesce((p->>'sin_iva')::boolean, true); v_iva_tasa numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
begin
  perform exigir(v_key is not null and length(v_key) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('apartado:' || v_key, 0));
  select * into v_ex from apartados where idempotency_key = v_key;
  if v_ex.id is not null then
    return jsonb_build_object('apartado_id', v_ex.id, 'serie', v_ex.serie, 'folio', v_ex.folio, 'repetida', true);
  end if;

  perform exigir(opera_sucursal(v_suc), 'No puedes apartar en esta sucursal');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and (v_al.sucursal_id = v_suc or v_al.multisucursal) and opera_almacen(v_al.id),
                 'Almacén no válido para esta sucursal');
  select * into v_cli from clientes where id = nullif(p->>'cliente_id','')::uuid;
  perform exigir(v_cli.id is not null and v_cli.activo and not v_cli.es_publico_general,
                 'El apartado requiere un cliente registrado (nombre y teléfono)');
  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, v_cli.id);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;

  perform bloquear_existencias((
    select coalesce(jsonb_agg(jsonb_build_object('producto_id', pr.id, 'almacen_id', v_al.id)), '[]')
      from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
     where pr.tipo = 'producto'));

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'apartado') s;
  insert into apartados (id, sucursal_id, almacen_id, serie, folio, cliente_id, vendedor_id, lista_id, comentarios, idempotency_key, sin_iva)
  values (v_id, v_suc, v_al.id, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, nullif(trim(p->>'comentarios'), ''), v_key, v_sin_iva);

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce((x->>'descuento')::numeric, 0) descuento,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.tipo, pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre,
                  pr.nombre_libre, pr.precio_libre, nullif(trim(x->>'descripcion'), '') descripcion, nullif(trim(x->>'comentario'), '') comentario
             from (select value as x, ordinality as n from jsonb_array_elements(p->'partidas') with ordinality) e
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
            order by e.n
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo and r.cantidad > 0, 'Partida inválida');
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    perform exigir(not r.nombre_libre or r.descripcion is not null, r.producto_nombre || ': escribe el nombre del concepto');
    perform exigir(r.precio = v_precio_lista or (r.precio_libre and r.precio >= 0) or tiene_permiso('modificar_precios'), r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), r.producto_nombre || ': no tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    v_iva_tasa := case when v_sin_iva then 0 else r.iva_tasa end;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, v_iva_tasa, r.ieps_tasa, v_incl);
    insert into apartado_partidas (apartado_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad, cantidad_base,
      precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total, descripcion, comentario)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre),
      r.precio, r.descuento, v_iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, case when r.nombre_libre then r.descripcion end, r.comentario);
    -- Reserva: no descuenta, solo aparta
    if r.tipo = 'producto' then
      update existencias set apartado = apartado + cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre), actualizado_en = now()
       where producto_id = r.producto_id and almacen_id = v_al.id;
    end if;
    t_sub := t_sub + c.subtotal; t_desc := t_desc + r.descuento; t_ieps := t_ieps + c.ieps; t_iva := t_iva + c.iva; t_tot := t_tot + c.total;
  end loop;
  perform exigir(v_ren > 0, 'El apartado no tiene partidas');

  for r in select x->>'forma' forma, (x->>'importe')::numeric importe, x->>'referencia' referencia
             from jsonb_array_elements(coalesce(p->'pagos','[]')) x
  loop
    continue when r.importe is null or r.importe = 0;
    perform exigir(r.importe > 0, 'Importe de anticipo inválido');
    perform exigir(r.forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia'), 'Forma de pago del anticipo no válida');
    insert into apartado_pagos (apartado_id, tipo, forma, importe, referencia, usuario_id)
    values (v_id, 'anticipo', r.forma, r.importe, r.referencia, auth.uid());
    v_ant := v_ant + r.importe;
  end loop;

  select round(t_tot * apartado_anticipo_minimo / 100, 2) into v_min from empresa where id = 1;
  perform exigir(v_ant >= v_min, format('El anticipo mínimo es %s (%s%% del total)', v_min,
                 (select apartado_anticipo_minimo from empresa where id = 1)));
  perform exigir(v_ant < t_tot, 'El anticipo cubre el total: registra una venta en lugar de un apartado');
  perform registrar_bitacora('crear', 'apartados', v_id::text, null, jsonb_build_object('total', t_tot, 'anticipo', v_ant));

  update apartados set subtotal = t_sub, descuento = t_desc, ieps = t_ieps, iva = t_iva, total = t_tot,
                       abonado = v_ant, saldo = t_tot - v_ant
   where id = v_id;
  return jsonb_build_object('apartado_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', t_tot,
                            'abonado', v_ant, 'saldo', t_tot - v_ant, 'repetida', false);
end $$;

-- La versión anterior (retención fija configurada) se reemplaza por la de abajo
drop function if exists public.cancelar_apartado(uuid, text, text, numeric);

-- Cancelar: p = {apartado_id, motivo, retener (importe de 0 a lo abonado), destino: 'dinero'|'saldo_favor', forma}
create or replace function public.cancelar_apartado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a apartados%rowtype; v_ret numeric := coalesce(nullif(p->>'retener','')::numeric, 0); v_dev numeric; r record;
        v_dest text := coalesce(nullif(p->>'destino',''), 'dinero'); v_forma text := coalesce(nullif(p->>'forma',''), 'efectivo');
begin
  select * into a from apartados where id = nullif(p->>'apartado_id','')::uuid for update;
  perform exigir(a.id is not null, 'Apartado no encontrado');
  perform exigir(opera_sucursal(a.sucursal_id), 'No puedes cancelar apartados de esta sucursal');
  perform exigir(tiene_permiso('cancelar_apartados'), 'No tienes permiso para cancelar apartados');
  perform exigir(a.estado = 'abierto', 'El apartado ya está ' || a.estado);
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'El motivo es obligatorio');
  perform exigir(v_ret >= 0 and v_ret <= a.abonado, format('Lo retenido debe ser de 0 a lo abonado (%s)', a.abonado));
  perform exigir(v_dest in ('dinero','saldo_favor'), 'Indica si el resto se devuelve o queda a favor');
  perform exigir(v_dest = 'saldo_favor' or v_forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia'), 'Forma de devolución no válida');
  v_dev := a.abonado - v_ret;

  perform bloquear_existencias((select coalesce(jsonb_agg(jsonb_build_object('producto_id', producto_id, 'almacen_id', a.almacen_id)), '[]')
                                  from apartado_partidas where apartado_id = a.id));
  for r in select ap.producto_id, sum(ap.cantidad_base) cb from apartado_partidas ap join productos pr on pr.id = ap.producto_id
            where ap.apartado_id = a.id and pr.tipo = 'producto' group by ap.producto_id loop
    update existencias set apartado = greatest(apartado - r.cb, 0), actualizado_en = now() where producto_id = r.producto_id and almacen_id = a.almacen_id;
  end loop;

  if v_dev > 0 then
    if v_dest = 'saldo_favor' then
      perform mover_saldo_favor(a.cliente_id, v_dev, null, format('Cancelación del apartado %s %s', a.serie, a.folio));
    else
      insert into apartado_pagos (apartado_id, tipo, forma, importe, usuario_id) values (a.id, 'devolucion', v_forma, v_dev, auth.uid());
    end if;
  end if;
  update apartados set estado = 'cancelado', saldo = 0, retenido = v_ret, devuelto = v_dev,
                       porcentaje_retencion = case when a.abonado > 0 then round(v_ret * 100 / a.abonado, 2) else 0 end,
                       cancelacion_destino = case when v_dev > 0 then v_dest end,
                       motivo_cancelacion = trim(p->>'motivo'), cancelado_en = now(), cancelado_por = auth.uid()
   where id = a.id;
  perform registrar_bitacora('cancelar', 'apartados', a.id::text, to_jsonb(a),
    jsonb_build_object('motivo', p->>'motivo', 'retenido', v_ret, 'devuelto', v_dev, 'destino', v_dest, 'forma', v_forma));
  return jsonb_build_object('retenido', v_ret, 'devuelto', v_dev, 'destino', v_dest);
end $$;

revoke execute on function public.crear_apartado(jsonb), public.cancelar_apartado(jsonb) from public, anon;
grant execute on function public.crear_apartado(jsonb), public.cancelar_apartado(jsonb) to authenticated;

commit;
