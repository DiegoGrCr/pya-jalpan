-- =============================================================================
-- Productos más vendidos: para la lista que aparece al buscar un producto en Capturar venta
-- sin haber escrito nada. Cuenta en cuántas ventas confirmadas aparece cada producto
-- en los últimos 90 días (en la sucursal indicada, o en todas). Solo devuelve ids y conteo.
-- Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.productos_mas_vendidos(p_sucursal uuid default null, p_limite int default 30)
returns table (producto_id uuid, ventas bigint)
language sql stable security definer set search_path = public as $$
  select vp.producto_id, count(distinct v.id) as ventas
    from venta_partidas vp
    join ventas v on v.id = vp.venta_id
    join productos p on p.id = vp.producto_id and p.activo
   where v.estado = 'confirmada'
     and v.fecha >= now() - interval '90 days'
     and (p_sucursal is null or v.sucursal_id = p_sucursal)
     and exists (select 1 from perfiles where user_id = auth.uid() and activo)
   group by vp.producto_id
   order by ventas desc, vp.producto_id
   limit least(greatest(coalesce(p_limite, 30), 1), 100);
$$;

revoke all on function public.productos_mas_vendidos(uuid, int) from public, anon;
grant execute on function public.productos_mas_vendidos(uuid, int) to authenticated;
