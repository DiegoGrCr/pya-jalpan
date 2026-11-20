-- =============================================================================
-- 0048 · Inventario desde hoja de cálculo (Google Sheets) por almacén.
--   · almacenes.fuente_inventario: 'sistema' (el kardex manda) u 'hoja' (la hoja manda).
--   · almacenes.hoja_url: enlace de la hoja (compartida como "Cualquier persona con el enlace · Lector").
--   · configurar_hoja_almacen: elegir fuente y enlace (permiso administrar).
--   · sincronizar_hoja: recibe lo que dice la hoja por SKU y deja la existencia del almacén igual;
--     cada diferencia queda en el kardex como ajuste "Sincronización con hoja de cálculo".
--     Los productos que no aparecen en la hoja no se tocan (se reportan).
-- La suma de todos los almacenes es la existencia total (pantalla de existencias).
-- Requiere 0047. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.almacenes add column if not exists fuente_inventario text not null default 'sistema'
  check (fuente_inventario in ('sistema', 'hoja'));
alter table public.almacenes add column if not exists hoja_url text;
alter table public.almacenes add column if not exists hoja_sincronizada_en timestamptz;
alter table public.almacenes add column if not exists hoja_resultado jsonb;

-- {almacen_id, fuente: 'sistema'|'hoja', hoja_url?}
create or replace function public.configurar_hoja_almacen(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_url text := nullif(trim(p->>'hoja_url'), ''); v_fuente text := coalesce(nullif(p->>'fuente',''), 'sistema');
begin
  perform exigir(tiene_permiso('administrar'), 'Solo un administrador puede cambiar la fuente del inventario');
  perform exigir(v_fuente in ('sistema', 'hoja'), 'Fuente no válida');
  perform exigir(v_url is null or v_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]+', 'El enlace debe ser de una hoja de cálculo de Google');
  perform exigir(v_fuente = 'sistema' or v_url is not null, 'Para usar la hoja escribe su enlace');
  update almacenes set fuente_inventario = v_fuente, hoja_url = v_url where id = (p->>'almacen_id')::uuid;
  perform exigir(found, 'Almacén no encontrado');
  perform registrar_bitacora('configurar_hoja', 'almacenes', p->>'almacen_id', null, p);
  return jsonb_build_object('almacen_id', p->>'almacen_id', 'fuente', v_fuente);
end $$;

-- {almacen_id, filas: [{sku, cajas?, sueltas?, cantidad?, hoja?, fila?}]}
--   Pisos: cajas × piezas por caja + piezas sueltas (en piezas). Otros: cantidad en su unidad base.
create or replace function public.sincronizar_hoja(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_alm almacenes%rowtype; v_doc uuid := gen_random_uuid(); r record; v_actual numeric; v_dif numeric;
  v_cambios int := 0; v_iguales int := 0; v_desconocidos jsonb := '[]'; v_sin_hoja int := 0; v_detalle jsonb := '[]'; v_res jsonb;
begin
  select * into v_alm from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_alm.id is not null, 'Almacén no encontrado');
  perform exigir(opera_almacen(v_alm.id), 'No tienes acceso a este almacén');
  perform exigir(v_alm.fuente_inventario = 'hoja', 'Este almacén no usa hoja de cálculo como inventario');
  perform exigir(jsonb_typeof(p->'filas') = 'array', 'No llegaron filas de la hoja');
  perform pg_advisory_xact_lock(hashtextextended('hoja:' || v_alm.id::text, 0));

  -- SKU que no existen en el sistema (se reportan, no se crean)
  select coalesce(jsonb_agg(distinct upper(trim(x->>'sku'))), '[]') into v_desconocidos
    from jsonb_array_elements(p->'filas') x
   where not exists (select 1 from productos pr where pr.sku = upper(trim(x->>'sku')));

  perform bloquear_existencias((
    select coalesce(jsonb_agg(distinct jsonb_build_object('producto_id', pr.id, 'almacen_id', v_alm.id)), '[]')
      from jsonb_array_elements(p->'filas') x join productos pr on pr.sku = upper(trim(x->>'sku')) where pr.tipo = 'producto'));

  for r in
    select pr.id, pr.sku, pr.nombre,
           -- si el SKU se repite en la hoja, se suma
           sum(case when x ? 'cantidad' and nullif(x->>'cantidad','') is not null then (x->>'cantidad')::numeric
                    else coalesce(nullif(x->>'cajas','')::numeric, 0) * coalesce(pr.piezas_por_caja, 1) + coalesce(nullif(x->>'sueltas','')::numeric, 0) end) hoja
      from jsonb_array_elements(p->'filas') x join productos pr on pr.sku = upper(trim(x->>'sku'))
     where pr.tipo = 'producto'
     group by pr.id, pr.sku, pr.nombre
  loop
    select coalesce(cantidad, 0) into v_actual from existencias where producto_id = r.id and almacen_id = v_alm.id;
    v_dif := round(r.hoja - coalesce(v_actual, 0), 6);
    if v_dif = 0 then v_iguales := v_iguales + 1; continue; end if;
    perform mover_inventario(r.id, v_alm.id, v_dif, 'ajuste', 'hoja', v_doc, coalesce(costo_venta(r.id), 0), 'Sincronización con hoja de cálculo');
    v_cambios := v_cambios + 1;
    if jsonb_array_length(v_detalle) < 200 then
      v_detalle := v_detalle || jsonb_build_object('sku', r.sku, 'nombre', r.nombre, 'antes', coalesce(v_actual, 0), 'hoja', r.hoja);
    end if;
  end loop;

  -- Productos con existencia en este almacén que no aparecen en la hoja (no se tocan)
  select count(*) into v_sin_hoja from existencias e join productos pr on pr.id = e.producto_id
   where e.almacen_id = v_alm.id and e.cantidad <> 0
     and not exists (select 1 from jsonb_array_elements(p->'filas') x where upper(trim(x->>'sku')) = pr.sku);

  v_res := jsonb_build_object('cambios', v_cambios, 'iguales', v_iguales, 'desconocidos', v_desconocidos,
                              'sin_hoja', v_sin_hoja, 'detalle', v_detalle, 'filas', jsonb_array_length(p->'filas'),
                              'avisos', coalesce(p->'avisos', '[]'::jsonb));
  update almacenes set hoja_sincronizada_en = now(), hoja_resultado = v_res where id = v_alm.id;
  if v_cambios > 0 then
    perform registrar_bitacora('sincronizar_hoja', 'almacenes', v_alm.id::text, null, jsonb_build_object('cambios', v_cambios, 'documento', v_doc));
  end if;
  return v_res;
end $$;

revoke execute on function public.configurar_hoja_almacen(jsonb), public.sincronizar_hoja(jsonb) from public, anon;
grant execute on function public.configurar_hoja_almacen(jsonb), public.sincronizar_hoja(jsonb) to authenticated;
