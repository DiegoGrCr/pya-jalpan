-- =============================================================================
-- 0033 · Reporte de ventas: forma de pago
-- Filtro nuevo en p: forma_pago ('efectivo'|'tarjeta_debito'|'tarjeta_credito'|'transferencia'|'saldo_favor'|'anticipo'):
-- ventas que tienen al menos un pago con esa forma. reporte_ventas devuelve además formas [{forma, importe}].
-- Requiere 0030. Se puede ejecutar más de una vez.
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
            when 'pagada_abierta' then v.estado = 'confirmada' and v.saldo = 0 and not v.cerrada
            else true end)
     and (case p->>'cierre'
            when 'abierta' then v.estado = 'confirmada' and not v.cerrada
            when 'cerrada' then v.estado = 'confirmada' and v.cerrada
            else true end)
     and (case p->>'tipo'
            when 'credito' then v.tipo = 'credito'
            when 'abono'   then v.tipo = 'contado' and v.con_abono
            when 'contado' then v.tipo = 'contado' and not v.con_abono
            else true end)
     and (nullif(p->>'forma_pago','') is null
          or exists (select 1 from venta_pagos pg where pg.venta_id = v.id and pg.forma = p->>'forma_pago' and pg.importe > 0))
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

drop function if exists public.reporte_ventas(jsonb);
create or replace function public.reporte_ventas(p jsonb)
returns table (id uuid, serie text, folio bigint, fecha timestamptz, cliente text, cliente_id uuid, sucursal text, almacen text,
               vendedor_id uuid, tipo text, con_abono boolean, estado text, estatus text,
               subtotal numeric, descuento numeric, iva numeric, ieps numeric, total numeric, pagado numeric, saldo numeric,
               costo numeric, orden_compra text, comentarios text, cerrada boolean, formas jsonb)
language sql stable security invoker set search_path = public as $$
  select v.id, v.serie, v.folio, v.fecha, coalesce(c.razon_social, c.nombre), v.cliente_id,
         s.codigo || ' - ' || s.nombre, a.nombre, v.vendedor_id, v.tipo, v.con_abono, v.estado,
         case when v.estado = 'cancelada' then 'cancelada' when v.saldo > 0 then 'activa' else 'pagada' end,
         v.subtotal + v.descuento, v.descuento, v.iva, v.ieps, v.total, v.pagado, v.saldo,
         coalesce((select sum(round(vp.cantidad_base * vp.costo_unitario_base, 2)) from venta_partidas vp where vp.venta_id = v.id), 0),
         v.orden_compra, v.comentarios, v.cerrada,
         coalesce((select jsonb_agg(jsonb_build_object('forma', pg.forma, 'importe', pg.importe) order by pg.fecha)
                     from venta_pagos pg where pg.venta_id = v.id and pg.importe > 0), '[]')
    from ventas_filtradas(p) v
    left join clientes c on c.id = v.cliente_id
    left join sucursales s on s.id = v.sucursal_id
    left join almacenes a on a.id = v.almacen_id
   order by v.fecha desc
   limit 20000;
$$;

revoke execute on function public.ventas_filtradas(jsonb), public.reporte_ventas(jsonb) from public, anon;
grant execute on function public.ventas_filtradas(jsonb), public.reporte_ventas(jsonb) to authenticated;
