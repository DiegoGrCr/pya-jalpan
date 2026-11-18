-- =============================================================================
-- 0032 · Consulta de existencias por producto y almacén (Inventarios › Almacenes y existencias)
-- existencias_consulta(p) con los permisos del usuario (security invoker).
-- p: {texto?, marca_id?, categoria_id?, almacen_id?, filtro?: 'con'|'sin'|'negativa', inactivos?: bool,
--     limite? (50), desplazamiento? (0)}
-- Una fila por producto: total (en unidad base, de todos los almacenes o del elegido), apartado,
-- y por_almacen [{almacen_id, cantidad, apartado}]. total_filas para paginar.
-- Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.existencias_consulta(p jsonb)
returns table (producto_id uuid, sku text, nombre text, formato text, presentacion text, unidad_base text,
               piezas_por_caja integer, m2_por_caja numeric, marca text, categoria text, activo boolean,
               costo numeric, total numeric, apartado numeric, por_almacen jsonb, total_filas bigint)
language sql stable security invoker set search_path = public as $$
  with par as (
    select nullif(trim(p->>'texto'), '') texto, nullif(p->>'marca_id','')::uuid marca, nullif(p->>'categoria_id','')::uuid cat,
           nullif(p->>'almacen_id','')::uuid alm, coalesce(p->>'filtro', '') filtro, coalesce((p->>'inactivos')::boolean, false) inactivos,
           least(coalesce(nullif(p->>'limite','')::int, 50), 5000) lim, coalesce(nullif(p->>'desplazamiento','')::int, 0) desp
  ),
  base as (
    select pr.id, pr.sku, pr.nombre, pr.formato, pr.presentacion, pr.unidad_base, pr.piezas_por_caja, pr.m2_por_caja,
           ma.nombre marca, cat.nombre categoria, pr.activo,
           coalesce(nullif(pr.costo_promedio, 0), pr.ultimo_costo, 0) costo,
           coalesce((select sum(e.cantidad) from existencias e, par where e.producto_id = pr.id and (par.alm is null or e.almacen_id = par.alm)), 0) total,
           coalesce((select sum(e.apartado) from existencias e, par where e.producto_id = pr.id and (par.alm is null or e.almacen_id = par.alm)), 0) apartado,
           coalesce((select jsonb_agg(jsonb_build_object('almacen_id', e.almacen_id, 'cantidad', e.cantidad, 'apartado', e.apartado))
                       from existencias e where e.producto_id = pr.id and (e.cantidad <> 0 or e.apartado <> 0)), '[]') por_almacen
      from productos pr
      left join marcas ma on ma.id = pr.marca_id
      left join categorias cat on cat.id = pr.categoria_id, par
     where pr.tipo = 'producto'
       and (par.inactivos or pr.activo)
       and (par.texto is null or pr.sku ilike '%' || par.texto || '%' or pr.nombre ilike '%' || par.texto || '%'
            or pr.formato ilike '%' || par.texto || '%' or pr.codigo_barras = par.texto)
       and (par.marca is null or pr.marca_id = par.marca)
       and (par.cat is null or pr.categoria_id = par.cat)
  ),
  filtrada as (
    select b.* from base b, par
     where case par.filtro when 'con' then b.total > 0 when 'sin' then b.total = 0 when 'negativa' then b.total < 0 else true end
  )
  select f.id, f.sku, f.nombre, f.formato, f.presentacion, f.unidad_base, f.piezas_por_caja, f.m2_por_caja, f.marca, f.categoria,
         f.activo, f.costo, f.total, f.apartado, f.por_almacen, count(*) over ()
    from filtrada f, par
   order by f.marca nulls last, f.formato nulls last, f.nombre
   limit (select lim from par) offset (select desp from par);
$$;
revoke execute on function public.existencias_consulta(jsonb) from public, anon;
grant execute on function public.existencias_consulta(jsonb) to authenticated;
