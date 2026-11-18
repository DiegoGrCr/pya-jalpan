-- =============================================================================
-- 0026 · Reporte histórico de ventas
-- Consultas con los permisos del usuario (security invoker): cada quien ve solo las
-- ventas de sus sucursales. Filtros en p (todos opcionales):
--   desde, hasta (AAAA-MM-DD, hora del centro de México), sucursal_id, almacen_id, vendedor_id,
--   cliente (texto: nombre / razón social / RFC), estatus ('pagada'|'activa'|'cancelada'),
--   tipo ('contado'|'credito'|'abono'), producto (texto: SKU / nombre), categoria_id, marca_id,
--   orden_compra, serie, comentario.
-- Requiere 0020 (orden_compra) y 0025 (con_abono). Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.ventas_filtradas(p jsonb)
returns setof public.ventas language sql stable security invoker set search_path = public as $$
  select v.* from ventas v
    left join clientes c on c.id = v.cliente_id
   where (nullif(p->>'desde','') is null or v.fecha >= ((p->>'desde')::date::timestamp at time zone 'America/Mexico_City'))
     and (nullif(p->>'hasta','') is null or v.fecha <  (((p->>'hasta')::date + 1)::timestamp at time zone 'America/Mexico_City'))
     and (nullif(p->>'sucursal_id','') is null or v.sucursal_id = (p->>'sucursal_id')::uuid)
     and (nullif(p->>'almacen_id','') is null or v.almacen_id = (p->>'almacen_id')::uuid)
     and (nullif(p->>'vendedor_id','') is null or v.vendedor_id = (p->>'vendedor_id')::uuid)
     and (nullif(p->>'cliente','') is null or c.nombre ilike '%' || (p->>'cliente') || '%'
          or c.razon_social ilike '%' || (p->>'cliente') || '%' or c.rfc ilike '%' || (p->>'cliente') || '%')
     and (case p->>'estatus'
            when 'cancelada' then v.estado = 'cancelada'
            when 'pagada'    then v.estado = 'confirmada' and v.saldo = 0
            when 'activa'    then v.estado = 'confirmada' and v.saldo > 0
            else true end)
     and (case p->>'tipo'
            when 'credito' then v.tipo = 'credito'
            when 'abono'   then v.tipo = 'contado' and v.con_abono
            when 'contado' then v.tipo = 'contado' and not v.con_abono
            else true end)
     and (nullif(p->>'orden_compra','') is null or v.orden_compra ilike '%' || (p->>'orden_compra') || '%')
     and (nullif(p->>'serie','') is null or v.serie ilike (p->>'serie'))
     and (nullif(p->>'comentario','') is null or v.comentarios ilike '%' || (p->>'comentario') || '%')
     and ((coalesce(p->>'producto','') = '' and nullif(p->>'categoria_id','') is null and nullif(p->>'marca_id','') is null)
          or exists (select 1 from venta_partidas vp join productos pr on pr.id = vp.producto_id
                      where vp.venta_id = v.id
                        and (coalesce(p->>'producto','') = '' or pr.sku ilike '%' || (p->>'producto') || '%' or pr.nombre ilike '%' || (p->>'producto') || '%')
                        and (nullif(p->>'categoria_id','') is null or pr.categoria_id = (p->>'categoria_id')::uuid)
                        and (nullif(p->>'marca_id','') is null or pr.marca_id = (p->>'marca_id')::uuid)));
$$;

-- Una fila por venta, con costo y utilidad (subtotal antes de descuento, como en las notas)
create or replace function public.reporte_ventas(p jsonb)
returns table (id uuid, serie text, folio bigint, fecha timestamptz, cliente text, cliente_id uuid, sucursal text, almacen text,
               vendedor_id uuid, tipo text, con_abono boolean, estado text, estatus text,
               subtotal numeric, descuento numeric, iva numeric, ieps numeric, total numeric, pagado numeric, saldo numeric,
               costo numeric, orden_compra text, comentarios text)
language sql stable security invoker set search_path = public as $$
  select v.id, v.serie, v.folio, v.fecha, coalesce(c.razon_social, c.nombre), v.cliente_id,
         s.codigo || ' - ' || s.nombre, a.nombre, v.vendedor_id, v.tipo, v.con_abono, v.estado,
         case when v.estado = 'cancelada' then 'cancelada' when v.saldo > 0 then 'activa' else 'pagada' end,
         v.subtotal + v.descuento, v.descuento, v.iva, v.ieps, v.total, v.pagado, v.saldo,
         coalesce((select sum(round(vp.cantidad_base * vp.costo_unitario_base, 2)) from venta_partidas vp where vp.venta_id = v.id), 0),
         v.orden_compra, v.comentarios
    from ventas_filtradas(p) v
    left join clientes c on c.id = v.cliente_id
    left join sucursales s on s.id = v.sucursal_id
    left join almacenes a on a.id = v.almacen_id
   order by v.fecha desc
   limit 20000;
$$;

-- Una fila por renglón vendido (para agrupar por producto, categoría o marca)
create or replace function public.reporte_ventas_partidas(p jsonb)
returns table (venta_id uuid, fecha timestamptz, estado text, producto_id uuid, sku text, producto text, formato text,
               m2_por_caja numeric, piezas_por_caja integer, categoria text, marca text, unidad_base text,
               cantidad_base numeric, total numeric, descuento numeric, costo numeric)
language sql stable security invoker set search_path = public as $$
  select v.id, v.fecha, v.estado, pr.id, pr.sku, pr.nombre, pr.formato, pr.m2_por_caja, pr.piezas_por_caja,
         cat.nombre, ma.nombre, pr.unidad_base, vp.cantidad_base, vp.total, vp.descuento,
         round(vp.cantidad_base * vp.costo_unitario_base, 2)
    from ventas_filtradas(p) v
    join venta_partidas vp on vp.venta_id = v.id
    join productos pr on pr.id = vp.producto_id
    left join categorias cat on cat.id = pr.categoria_id
    left join marcas ma on ma.id = pr.marca_id
   limit 100000;
$$;

revoke execute on function public.ventas_filtradas(jsonb), public.reporte_ventas(jsonb), public.reporte_ventas_partidas(jsonb) from public, anon;
grant execute on function public.ventas_filtradas(jsonb), public.reporte_ventas(jsonb), public.reporte_ventas_partidas(jsonb) to authenticated;
