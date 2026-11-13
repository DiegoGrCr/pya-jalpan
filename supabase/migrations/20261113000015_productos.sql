-- =============================================================================
-- 0015 · Alta de productos (formulario e importación desde Excel)
-- - Una sola lista de productos; marca y categoría opcionales (filtros y SKU).
-- - Pisos: inventario en PIEZAS (cajas × piezas + sueltas, sin redondeos), se venden
--   por CAJA o PIEZA; el precio se captura por m² y se calculan caja y pieza.
-- - Otros productos: una unidad (PIEZA, BULTO, KG, LITRO, ROLLO, METRO...).
-- - SKU automático: MARCA-FORMATO-### (p. ej. DAL-1850-001) o MARCA-### sin formato.
-- =============================================================================

alter table public.productos
  add column if not exists formato         text,                 -- '60x60', '18x50'
  add column if not exists presentacion    text not null default 'unidad' check (presentacion in ('piso','unidad')),
  add column if not exists piezas_por_caja integer check (piezas_por_caja > 0),
  add column if not exists m2_por_caja     numeric(18,6) check (m2_por_caja > 0),
  add column if not exists precio_m2       numeric(14,2) check (precio_m2 >= 0),
  add column if not exists comentarios     text;

-- Las remisiones no llevan IVA: un producto nuevo nace con IVA 0 %
alter table public.productos alter column iva_tasa set default 0;

alter table public.marcas add column if not exists prefijo text unique check (prefijo ~ '^[A-Z0-9]{2,4}$');

-- Permiso para dar de alta y editar productos y precios
insert into public.permisos (clave, descripcion) values ('editar_productos', 'Dar de alta y editar productos y precios')
on conflict do nothing;
insert into public.rol_permisos (rol, permiso) values ('administrador','editar_productos'), ('gerente','editar_productos')
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Utilidades
-- -----------------------------------------------------------------------------
-- 'Ádhesivos 1000' -> 'ADH'
create or replace function public.prefijo_de(p_texto text)
returns text language sql immutable as $$
  select nullif(left(regexp_replace(upper(translate(coalesce(p_texto,''), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN')), '[^A-Z0-9]', '', 'g'), 3), '');
$$;

-- '60 x 120 cm' -> '60120'
create or replace function public.formato_sku(p_formato text)
returns text language sql immutable as $$
  select nullif(left(regexp_replace(lower(coalesce(p_formato,'')), '[^0-9]', '', 'g'), 8), '');
$$;

-- Marca o categoría por nombre (se crea si no existe). Devuelve null si el nombre viene vacío.
create or replace function public.marca_por_nombre(p_nombre text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_nombre text := nullif(trim(p_nombre), ''); v_pre text; n int := 0;
begin
  if v_nombre is null or lower(v_nombre) in ('sin marca', 'n/a', '-') then return null; end if;
  select id into v_id from marcas where lower(nombre) = lower(v_nombre);
  if v_id is not null then return v_id; end if;
  v_pre := coalesce(prefijo_de(v_nombre), 'GEN');
  while length(v_pre) >= 2 and exists (select 1 from marcas where prefijo = v_pre) loop
    n := n + 1;
    v_pre := left(coalesce(prefijo_de(v_nombre), 'GEN'), 2) || n::text;   -- DAL -> DA1, DA2...
  end loop;
  insert into marcas (nombre, prefijo) values (v_nombre, v_pre) returning id into v_id;
  return v_id;
end $$;

create or replace function public.categoria_por_nombre(p_nombre text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_nombre text := nullif(trim(p_nombre), '');
begin
  if v_nombre is null then return null; end if;
  select id into v_id from categorias where padre_id is null and lower(nombre) = lower(v_nombre);
  if v_id is null then insert into categorias (nombre) values (v_nombre) returning id into v_id; end if;
  return v_id;
end $$;

-- Siguiente SKU libre: DAL-1850-001, DAL-1850-002... o ADE-001 sin formato
create or replace function public.generar_sku(p_marca uuid, p_categoria uuid, p_formato text)
returns text language plpgsql security definer set search_path = public as $$
declare v_pre text; v_base text; n int;
begin
  select prefijo into v_pre from marcas where id = p_marca;
  if v_pre is null then select prefijo_de(nombre) into v_pre from categorias where id = p_categoria; end if;
  v_base := coalesce(v_pre, 'GEN') || coalesce('-' || formato_sku(p_formato), '') || '-';
  perform pg_advisory_xact_lock(hashtextextended('sku:' || v_base, 0));
  select coalesce(max(substring(sku from length(v_base) + 1)::int), 0) + 1 into n
    from productos where sku like v_base || '%' and substring(sku from length(v_base) + 1) ~ '^[0-9]+$';
  return v_base || lpad(n::text, 3, '0');
end $$;

-- -----------------------------------------------------------------------------
-- guardar_producto(p): alta o edición. Devuelve {producto_id, sku, nuevo}.
-- p: {id?, sku?, nombre, descripcion?, marca?, categoria?, formato?, presentacion: 'piso'|'unidad',
--     unidad?, piezas_por_caja?, m2_por_caja?, precio_m2?, precio?, precio_caja?, precio_pieza?,
--     codigo_barras?, tipo?, iva_tasa?, clave_sat_prodserv?, comentarios?, imagen_url?, activo?}
-- -----------------------------------------------------------------------------
create or replace function public.guardar_producto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p->>'id','')::uuid;
  v_ant productos%rowtype;
  v_pres text := coalesce(nullif(p->>'presentacion',''), 'unidad');
  v_nombre text := trim(coalesce(p->>'nombre',''));
  v_marca uuid := marca_por_nombre(p->>'marca');
  v_cat uuid := categoria_por_nombre(p->>'categoria');
  v_formato text := nullif(trim(p->>'formato'),'');
  v_sku text := nullif(upper(trim(p->>'sku')),'');
  v_unidad text := upper(coalesce(nullif(trim(p->>'unidad'),''), 'PIEZA'));
  v_piezas int := nullif(p->>'piezas_por_caja','')::int;
  v_m2 numeric := nullif(p->>'m2_por_caja','')::numeric;
  v_pm2 numeric := nullif(p->>'precio_m2','')::numeric;
  v_lista uuid; v_caja uuid; v_base uuid;
  v_pcaja numeric; v_ppieza numeric; v_precio numeric;
  v_nuevo boolean := v_id is null;
begin
  perform exigir(tiene_permiso('editar_productos'), 'No tienes permiso para dar de alta o editar productos');
  perform exigir(length(v_nombre) > 0, 'La descripción del producto es obligatoria');
  perform exigir(v_pres in ('piso','unidad'), 'Presentación no válida');
  perform exigir(coalesce((p->>'iva_tasa')::numeric, 0) in (0, 0.08, 0.16), 'Tasa de IVA no válida');
  select id into v_lista from listas_precios where predeterminada;
  perform exigir(v_lista is not null, 'No hay lista de precios predeterminada');

  if v_pres = 'piso' then
    perform exigir(v_piezas is not null, 'Piso: indica las piezas por caja');
    perform exigir(v_m2 is not null, 'Piso: indica los m² por caja');
    v_unidad := 'PIEZA';
  else
    perform exigir(v_unidad ~ '^[A-Z0-9]{1,10}$', 'Unidad no válida (p. ej. PIEZA, BULTO, KG)');
  end if;

  if not v_nuevo then
    select * into v_ant from productos where id = v_id for update;
    perform exigir(v_ant.id is not null, 'Producto no encontrado');
    perform exigir(v_ant.presentacion = v_pres and v_ant.unidad_base = v_unidad,
                   'No se puede cambiar la presentación ni la unidad de un producto ya creado; da de alta uno nuevo');
  end if;

  if v_sku is null then
    v_sku := case when v_nuevo then generar_sku(v_marca, v_cat, v_formato) else v_ant.sku end;
  end if;
  perform exigir(v_sku ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$', 'SKU no válido: ' || v_sku);
  perform exigir(not exists (select 1 from productos where sku = v_sku and id is distinct from v_id), 'Ya existe un producto con el SKU ' || v_sku);
  perform exigir(nullif(trim(p->>'codigo_barras'),'') is null or not exists (
                   select 1 from productos where codigo_barras = trim(p->>'codigo_barras') and id is distinct from v_id),
                 'Ese código de barras ya está en otro producto');

  if v_nuevo then
    insert into productos (sku, codigo_barras, nombre, descripcion, categoria_id, marca_id, tipo, imagen_url, activo,
                           unidad_base, clave_sat_prodserv, clave_sat_unidad, iva_tasa, permite_fraccion,
                           formato, presentacion, piezas_por_caja, m2_por_caja, precio_m2, comentarios)
    values (v_sku, nullif(trim(p->>'codigo_barras'),''), v_nombre, nullif(trim(p->>'descripcion'),''), v_cat, v_marca,
            coalesce(nullif(p->>'tipo',''), 'producto'), nullif(trim(p->>'imagen_url'),''), coalesce((p->>'activo')::boolean, true),
            v_unidad, coalesce(nullif(trim(p->>'clave_sat_prodserv'),''), case when v_pres = 'piso' then '30161602' else '01010101' end),
            case v_unidad when 'PIEZA' then 'H87' when 'KG' then 'KGM' when 'LITRO' then 'LTR' when 'METRO' then 'MTR'
                          when 'M2' then 'MTK' when 'ROLLO' then 'XRO' when 'BULTO' then 'XBG' when 'CAJA' then 'XBX' else 'H87' end,
            coalesce((p->>'iva_tasa')::numeric, 0), coalesce((p->>'permite_fraccion')::boolean, v_unidad in ('KG','LITRO','METRO','M2')),
            v_formato, v_pres, v_piezas, v_m2, v_pm2, nullif(trim(p->>'comentarios'),''))
    returning id into v_id;   -- el trigger crea la unidad base
  else
    update productos set sku = v_sku, codigo_barras = nullif(trim(p->>'codigo_barras'),''), nombre = v_nombre,
           descripcion = nullif(trim(p->>'descripcion'),''), categoria_id = v_cat, marca_id = v_marca,
           imagen_url = coalesce(nullif(trim(p->>'imagen_url'),''), imagen_url),
           activo = coalesce((p->>'activo')::boolean, activo),
           clave_sat_prodserv = coalesce(nullif(trim(p->>'clave_sat_prodserv'),''), clave_sat_prodserv),
           iva_tasa = coalesce((p->>'iva_tasa')::numeric, iva_tasa),
           formato = v_formato, piezas_por_caja = v_piezas, m2_por_caja = v_m2, precio_m2 = v_pm2,
           comentarios = nullif(trim(p->>'comentarios'),''), actualizado_en = now()
     where id = v_id;
  end if;

  select id into v_base from unidades_venta where producto_id = v_id and es_base;

  if v_pres = 'piso' then
    insert into unidades_venta (producto_id, nombre, factor, es_base, clave_sat_unidad, orden)
    values (v_id, 'CAJA', v_piezas, false, 'XBX', 1)
    on conflict (producto_id, nombre) do update set factor = excluded.factor, activa = true
    returning id into v_caja;
    update unidades_venta set orden = 2 where id = v_base;
    -- Precios: capturados, o calculados desde el precio por m²
    v_pcaja  := coalesce(nullif(p->>'precio_caja','')::numeric, round(v_m2 * v_pm2, 2));
    -- Pieza = área de la pieza (m² por caja ÷ piezas) × precio m²; si la caja se capturó a mano, caja ÷ piezas
    v_ppieza := coalesce(nullif(p->>'precio_pieza','')::numeric,
                         case when nullif(p->>'precio_caja','') is null and v_pm2 is not null
                              then round(v_m2 / v_piezas * v_pm2, 2) else round(v_pcaja / v_piezas, 2) end);
    perform exigir(v_pcaja is not null, 'Piso: indica el precio por m² o el precio por caja');
    insert into precios (lista_id, unidad_venta_id, precio) values (v_lista, v_caja, v_pcaja), (v_lista, v_base, v_ppieza)
    on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
  else
    v_precio := nullif(p->>'precio','')::numeric;
    perform exigir(v_precio is not null and v_precio >= 0, 'Indica el precio');
    insert into precios (lista_id, unidad_venta_id, precio) values (v_lista, v_base, v_precio)
    on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
  end if;

  perform registrar_bitacora(case when v_nuevo then 'crear' else 'actualizar' end, 'productos', v_id::text,
                             case when v_nuevo then null else to_jsonb(v_ant) end, p);
  return jsonb_build_object('producto_id', v_id, 'sku', v_sku, 'nuevo', v_nuevo);
end $$;

-- -----------------------------------------------------------------------------
-- importar_productos(p): carga masiva desde la plantilla de Excel, todo o nada.
-- p: {idempotency_key, almacen_id?, filas:[{fila, ...campos de guardar_producto, cajas?, piezas_sueltas?, cantidad?}]}
-- Si el producto ya existe (mismo SKU, o misma descripción + marca + formato) se actualiza;
-- la existencia solo se carga para productos NUEVOS (inventario inicial) para no duplicarla.
-- -----------------------------------------------------------------------------
create or replace function public.importar_productos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  f jsonb; r jsonb; v_id uuid; v_fila text; v_cant numeric; v_base uuid;
  v_creados int := 0; v_actualizados int := 0; v_partidas jsonb := '[]'; v_ajuste jsonb; v_res jsonb := '[]';
begin
  perform exigir(tiene_permiso('editar_productos'), 'No tienes permiso para dar de alta o editar productos');
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('importar:' || (p->>'idempotency_key'), 0));
  if exists (select 1 from bitacora where accion = 'importar' and entidad = 'productos' and entidad_id = p->>'idempotency_key') then
    return jsonb_build_object('repetida', true);
  end if;
  perform exigir(jsonb_typeof(p->'filas') = 'array' and jsonb_array_length(p->'filas') between 1 and 5000, 'La importación debe tener de 1 a 5000 filas');

  for f in select * from jsonb_array_elements(p->'filas') loop
    v_fila := coalesce(f->>'fila', '?');
    begin
      select pr.id into v_id from productos pr
       where (nullif(trim(f->>'sku'),'') is not null and pr.sku = upper(trim(f->>'sku')))
          or (nullif(trim(f->>'sku'),'') is null
              and lower(pr.nombre) = lower(trim(f->>'nombre'))
              and pr.marca_id is not distinct from (select id from marcas where lower(nombre) = lower(nullif(trim(f->>'marca'),'')))
              and coalesce(lower(pr.formato),'') = coalesce(lower(nullif(trim(f->>'formato'),'')),''))
       limit 1;
      r := guardar_producto(case when v_id is null then f - 'id' else f || jsonb_build_object('id', v_id) end);
    exception when others then
      raise exception 'Fila %: %', v_fila, sqlerrm;
    end;
    v_res := v_res || jsonb_build_object('fila', f->'fila', 'sku', r->>'sku', 'producto_id', r->>'producto_id', 'nuevo', (r->>'nuevo')::boolean);

    if (r->>'nuevo')::boolean then
      v_creados := v_creados + 1;
      -- existencia inicial en unidad base: pisos = cajas × piezas + sueltas; otros = cantidad
      v_cant := case when f->>'presentacion' = 'piso'
                     then coalesce(nullif(f->>'cajas','')::numeric, 0) * (f->>'piezas_por_caja')::numeric
                          + coalesce(nullif(f->>'piezas_sueltas','')::numeric, 0)
                     else coalesce(nullif(f->>'cantidad','')::numeric, 0) end;
      if v_cant <> 0 then
        perform exigir(nullif(p->>'almacen_id','') is not null, 'Elige el almacén para cargar las existencias');
        select id into v_base from unidades_venta where producto_id = (r->>'producto_id')::uuid and es_base;
        v_partidas := v_partidas || jsonb_build_object('producto_id', r->>'producto_id', 'unidad_venta_id', v_base, 'cantidad', v_cant);
      end if;
    else
      v_actualizados := v_actualizados + 1;
    end if;
  end loop;

  if jsonb_array_length(v_partidas) > 0 then
    v_ajuste := registrar_ajuste(jsonb_build_object('almacen_id', p->>'almacen_id', 'motivo', 'Inventario inicial (importación de productos)',
                  'origen', 'inventario_inicial', 'idempotency_key', 'imp-' || (p->>'idempotency_key'), 'partidas', v_partidas));
  end if;

  perform registrar_bitacora('importar', 'productos', p->>'idempotency_key', null,
          jsonb_build_object('creados', v_creados, 'actualizados', v_actualizados, 'almacen_id', p->>'almacen_id'));
  return jsonb_build_object('creados', v_creados, 'actualizados', v_actualizados,
                            'con_existencia', jsonb_array_length(v_partidas), 'ajuste', v_ajuste, 'productos', v_res, 'repetida', false);
end $$;

revoke execute on function public.prefijo_de(text), public.formato_sku(text), public.marca_por_nombre(text),
  public.categoria_por_nombre(text), public.generar_sku(uuid, uuid, text), public.guardar_producto(jsonb),
  public.importar_productos(jsonb) from public, anon;
grant execute on function public.guardar_producto(jsonb), public.importar_productos(jsonb),
  public.prefijo_de(text), public.formato_sku(text) to authenticated;
