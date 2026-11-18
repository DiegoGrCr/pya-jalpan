-- =============================================================================
-- 0037 · Cotizaciones: editar, cancelar, sin IVA, comentario por renglón y folio configurable
-- - guardar_cotizacion(p): alta o edición (p.id) mientras no esté convertida ni cancelada.
--   Remisión sin IVA por omisión (como la venta), comentario por renglón, orden de captura.
-- - cancelar_cotizacion(p): {id, motivo}.
-- - guardar_serie también valida folios de cotizaciones.
-- Requiere 0019 y 0028. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.cotizaciones        add column if not exists sin_iva            boolean not null default true;
alter table public.cotizaciones        add column if not exists motivo_cancelacion text;
alter table public.cotizaciones        add column if not exists cancelada_en       timestamptz;
alter table public.cotizaciones        add column if not exists editada_en         timestamptz;
alter table public.cotizacion_partidas add column if not exists comentario         text;

-- p: {id?, idempotency_key, sucursal_id, almacen_id, cliente_id|prospecto, lista_id?, vigencia?, comentarios?, sin_iva?,
--     partidas:[{producto_id, unidad_venta_id, cantidad, precio_unitario, descuento?, comentario?}]}
create or replace function public.guardar_cotizacion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p->>'id','')::uuid; v_ant cotizaciones%rowtype; v_serie text; v_folio bigint;
  v_lista uuid; v_incl boolean; r record; c record; v_ren int := 0; v_ex uuid; v_precio_lista numeric; v_precio_ant numeric;
  v_sin_iva boolean := coalesce((p->>'sin_iva')::boolean, true); v_iva numeric; v_previos jsonb := '[]';
begin
  select id into v_ex from cotizaciones where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then
    select serie, folio into v_serie, v_folio from cotizaciones where id = v_ex;
    return jsonb_build_object('cotizacion_id', v_ex, 'serie', v_serie, 'folio', v_folio, 'repetida', true);
  end if;

  if v_id is not null then
    select * into v_ant from cotizaciones where id = v_id for update;
    perform exigir(v_ant.id is not null, 'Cotización no encontrada');
    perform exigir(opera_sucursal(v_ant.sucursal_id), 'No puedes editar cotizaciones de esta sucursal');
    perform exigir(v_ant.estado in ('borrador','enviada'), 'La cotización ya está ' || v_ant.estado || '; no se puede editar');
  else
    perform exigir(opera_sucursal((p->>'sucursal_id')::uuid), 'No puedes cotizar en esta sucursal');
  end if;
  perform exigir(jsonb_typeof(p->'partidas') = 'array' and jsonb_array_length(p->'partidas') > 0, 'La cotización no tiene partidas');

  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, nullif(p->>'cliente_id','')::uuid);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;

  if v_id is null then
    select s.serie, s.folio into v_serie, v_folio from siguiente_folio((p->>'sucursal_id')::uuid, 'cotizacion') s;
    insert into cotizaciones (sucursal_id, almacen_id, serie, folio, cliente_id, prospecto, vendedor_id, lista_id, vigencia,
                              estado, comentarios, duplicada_de, idempotency_key, sin_iva)
    values ((p->>'sucursal_id')::uuid, (p->>'almacen_id')::uuid, v_serie, v_folio, nullif(p->>'cliente_id','')::uuid,
            nullif(p->>'prospecto',''), auth.uid(), v_lista,
            coalesce(nullif(p->>'vigencia','')::date, ((now() at time zone 'America/Mexico_City')::date + 15)),
            coalesce(nullif(p->>'estado',''), 'borrador'), nullif(trim(p->>'comentarios'), ''), nullif(p->>'duplicada_de','')::uuid,
            p->>'idempotency_key', v_sin_iva)
    returning id into v_id;
  else
    v_serie := v_ant.serie; v_folio := v_ant.folio;
    update cotizaciones set cliente_id = nullif(p->>'cliente_id','')::uuid, prospecto = nullif(p->>'prospecto',''),
           almacen_id = coalesce(nullif(p->>'almacen_id','')::uuid, almacen_id), lista_id = v_lista,
           vigencia = coalesce(nullif(p->>'vigencia','')::date, vigencia), comentarios = nullif(trim(p->>'comentarios'), ''),
           sin_iva = v_sin_iva, editada_en = now(), idempotency_key = p->>'idempotency_key'
     where id = v_id;
    -- Precios que ya tenía cotizados (se aceptan al editar aunque la lista haya cambiado)
    select coalesce(jsonb_agg(jsonb_build_object('unidad_venta_id', unidad_venta_id, 'precio_unitario', precio_unitario)), '[]')
      into v_previos from cotizacion_partidas where cotizacion_id = v_id;
    delete from cotizacion_partidas where cotizacion_id = v_id;
  end if;

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce(nullif(x->>'descuento','')::numeric, 0) descuento,
                  nullif(trim(x->>'comentario'), '') comentario,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre
             from (select value as x, ordinality as n from jsonb_array_elements(p->'partidas') with ordinality) e
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
            order by e.n
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo, 'Producto o unidad inválidos');
    perform exigir(r.cantidad > 0, r.producto_nombre || ': la cantidad debe ser mayor a cero');
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    -- Al editar se acepta el precio que ya tenía cotizado
    select t.precio_unitario into v_precio_ant from jsonb_to_recordset(v_previos) as t(unidad_venta_id uuid, precio_unitario numeric)
     where t.unidad_venta_id = r.unidad_id limit 1;
    perform exigir(r.precio = coalesce(v_precio_lista, r.precio) or r.precio = v_precio_ant or tiene_permiso('modificar_precios'),
                   r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), r.producto_nombre || ': no tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    v_iva := case when v_sin_iva then 0 else r.iva_tasa end;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, v_iva, r.ieps_tasa, v_incl);
    insert into cotizacion_partidas (cotizacion_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total, comentario)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad,
      cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre),
      r.precio, r.descuento, v_iva, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, r.comentario);
  end loop;

  update cotizaciones q set subtotal = s.subtotal, descuento = s.descuento, ieps = s.ieps, iva = s.iva, total = s.total
    from (select sum(subtotal) subtotal, sum(descuento) descuento, sum(ieps) ieps, sum(iva) iva, sum(total) total
            from cotizacion_partidas where cotizacion_id = v_id) s
   where q.id = v_id;

  perform registrar_bitacora(case when v_ant.id is null then 'crear' else 'editar' end, 'cotizaciones', v_id::text,
                             case when v_ant.id is null then null else to_jsonb(v_ant) end, jsonb_build_object('clave', p->>'idempotency_key'));
  return jsonb_build_object('cotizacion_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

-- {id, motivo}
create or replace function public.cancelar_cotizacion(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v cotizaciones%rowtype;
begin
  select * into v from cotizaciones where id = (p->>'id')::uuid for update;
  perform exigir(v.id is not null, 'Cotización no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes cancelar cotizaciones de esta sucursal');
  perform exigir(v.estado in ('borrador','enviada'), 'La cotización ya está ' || v.estado);
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'El motivo es obligatorio');
  update cotizaciones set estado = 'cancelada', motivo_cancelacion = trim(p->>'motivo'), cancelada_en = now() where id = v.id;
  perform registrar_bitacora('cancelar', 'cotizaciones', v.id::text, to_jsonb(v), jsonb_build_object('motivo', p->>'motivo'));
end $$;

revoke execute on function public.guardar_cotizacion(jsonb), public.cancelar_cotizacion(jsonb) from public, anon;
grant execute on function public.guardar_cotizacion(jsonb), public.cancelar_cotizacion(jsonb) to authenticated;

-- guardar_serie: también valida folios de cotizaciones
create or replace function public.guardar_serie(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_suc uuid := (p->>'sucursal_id')::uuid;
  v_tipo text := coalesce(nullif(p->>'tipo_documento',''), 'venta');
  v_pre text := upper(trim(coalesce(p->>'prefijo','')));
  v_sig bigint := coalesce(nullif(p->>'siguiente','')::bigint, 1);
  v_max bigint; v_id uuid;
begin
  perform exigir(es_admin(), 'Solo un administrador puede cambiar los folios');
  perform exigir(exists (select 1 from sucursales where id = v_suc), 'Sucursal no encontrada');
  perform exigir(v_pre ~ '^[A-Z0-9]{1,6}$', 'La abreviación debe tener de 1 a 6 letras o números (p. ej. AR)');
  perform exigir(v_sig >= 1, 'El número siguiente debe ser 1 o mayor');
  -- No repetir folios ya usados con esa abreviación
  if v_tipo = 'venta' then
    select max(folio) into v_max from ventas where sucursal_id = v_suc and serie = v_pre;
  elsif v_tipo = 'cotizacion' then
    select max(folio) into v_max from cotizaciones where sucursal_id = v_suc and serie = v_pre;
  end if;
  perform exigir(v_max is null or v_sig > v_max, format('Con la abreviación %s ya existe hasta el folio %s; el siguiente debe ser mayor', v_pre, v_max));
  update series set activa = false where sucursal_id = v_suc and tipo_documento = v_tipo and activa and prefijo <> v_pre;
  insert into series (sucursal_id, tipo_documento, prefijo, siguiente, activa) values (v_suc, v_tipo, v_pre, v_sig, true)
  on conflict (sucursal_id, tipo_documento, prefijo) do update set siguiente = excluded.siguiente, activa = true
  returning id into v_id;
  perform registrar_bitacora('serie', 'series', v_id::text, null, p);
  return jsonb_build_object('serie_id', v_id, 'prefijo', v_pre, 'siguiente', v_sig);
end $$;
