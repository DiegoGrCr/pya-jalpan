-- =============================================================================
-- 0018 · Productos sin precio y sin descripción
-- Un producto se puede dar de alta (formulario o Excel) sin precio: se carga igual y el
-- precio se captura después. Sin descripción, el nombre es marca + formato + SKU. Al vender, un renglón con precio 0 no se deja confirmar.
-- Si al reimportar una fila viene sin precio, se conserva el precio que ya tenía.
-- Se puede ejecutar más de una vez.
-- =============================================================================
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
  if length(v_nombre) = 0 then   -- sin descripción: marca + formato + SKU
    v_nombre := concat_ws(' ', (select nombre from marcas where id = v_marca), v_formato, v_sku);
  end if;
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
           formato = v_formato, piezas_por_caja = v_piezas, m2_por_caja = v_m2, precio_m2 = coalesce(v_pm2, precio_m2),
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
    v_pcaja  := coalesce(nullif(p->>'precio_caja','')::numeric, v_m2 * v_pm2);   -- sin redondear (ver 0016)
    -- Pieza = área de la pieza (m² por caja ÷ piezas) × precio m², sin redondear; si la caja se capturó a mano, caja ÷ piezas
    v_ppieza := coalesce(nullif(p->>'precio_pieza','')::numeric,
                         case when nullif(p->>'precio_caja','') is null and v_pm2 is not null
                              then v_m2 / v_piezas * v_pm2 else v_pcaja / v_piezas end);
    -- Sin precio: el producto se da de alta igual (se captura después); si ya tenía, se conserva
    if v_pcaja is not null then
      perform exigir(v_pcaja >= 0 and v_ppieza >= 0, 'El precio no puede ser negativo');
      insert into precios (lista_id, unidad_venta_id, precio) values (v_lista, v_caja, v_pcaja), (v_lista, v_base, v_ppieza)
      on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
    end if;
  else
    v_precio := nullif(p->>'precio','')::numeric;
    if v_precio is not null then
      perform exigir(v_precio >= 0, 'El precio no puede ser negativo');
      insert into precios (lista_id, unidad_venta_id, precio) values (v_lista, v_base, v_precio)
      on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
    end if;
  end if;

  perform registrar_bitacora(case when v_nuevo then 'crear' else 'actualizar' end, 'productos', v_id::text,
                             case when v_nuevo then null else to_jsonb(v_ant) end, p);
  return jsonb_build_object('producto_id', v_id, 'sku', v_sku, 'nuevo', v_nuevo);
end $$;
