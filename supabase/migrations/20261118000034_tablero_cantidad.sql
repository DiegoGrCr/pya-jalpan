-- =============================================================================
-- 0034 · Tablero: productos más vendidos por dinero y por cantidad (m² en pisos, unidad en lo demás)
-- p acepta además categoria_id para limitar los productos más vendidos a una categoría.
-- Requiere 0031. Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.tablero(p jsonb)
returns jsonb language sql stable security invoker set search_path = public as $$
  with
  par as (
    select coalesce(nullif(p->>'desde','')::date, date_trunc('month', now() at time zone 'America/Mexico_City')::date) desde,
           coalesce(nullif(p->>'hasta','')::date, (now() at time zone 'America/Mexico_City')::date) hasta,
           nullif(p->>'sucursal_id','')::uuid suc,
           nullif(p->>'categoria_id','')::uuid cat,
           (date_trunc('month', now() at time zone 'America/Mexico_City') - interval '23 months')::date inicio24
  ),
  v as (   -- ventas confirmadas (todas las fechas) del alcance
    select v.*, (v.fecha at time zone 'America/Mexico_City')::date dia
      from ventas v, par where v.estado = 'confirmada' and (par.suc is null or v.sucursal_id = par.suc)
  ),
  vr as (select v.* from v, par where v.dia between par.desde and par.hasta),
  meses as (select to_char(m, 'YYYY-MM') mes from par, generate_series(par.inicio24, par.inicio24 + interval '23 months', interval '1 month') m),
  pagos as (
    select (pg.fecha at time zone 'America/Mexico_City')::date dia, pg.importe
      from venta_pagos pg join ventas v on v.id = pg.venta_id, par
     where v.estado = 'confirmada' and pg.forma <> 'saldo_favor' and (par.suc is null or v.sucursal_id = par.suc)
  ),
  devol as (
    select (d.fecha at time zone 'America/Mexico_City')::date dia, d.importe
      from venta_devoluciones d join ventas v on v.id = d.venta_id, par where par.suc is null or v.sucursal_id = par.suc
  ),
  partidas as (
    select vp.*, pr.sku, pr.nombre, pr.formato, pr.m2_por_caja, pr.piezas_por_caja, pr.unidad_base, pr.categoria_id,
           coalesce(cat.nombre, 'Sin categoría') categoria,
           -- cantidad comparable: m² en pisos, unidad base en lo demás
           case when pr.m2_por_caja is not null and pr.piezas_por_caja > 0 then vp.cantidad_base * pr.m2_por_caja / pr.piezas_por_caja
                else vp.cantidad_base end medida
      from vr join venta_partidas vp on vp.venta_id = vr.id
      join productos pr on pr.id = vp.producto_id
      left join categorias cat on cat.id = pr.categoria_id
  ),
  prod as (
    select sku, nombre, formato, m2_por_caja, unidad_base, sum(total) total, sum(cantidad_base) cantidad_base,
           sum(case when m2_por_caja is not null and piezas_por_caja > 0 then cantidad_base * m2_por_caja / piezas_por_caja end) m2,
           sum(medida) medida
      from partidas, par where par.cat is null or partidas.categoria_id = par.cat
     group by sku, nombre, formato, m2_por_caja, unidad_base
  )
  select jsonb_build_object(
    'desde', (select desde from par), 'hasta', (select hasta from par),
    'ventas_mes', (select coalesce(jsonb_agg(jsonb_build_object('mes', m.mes,
        'total', coalesce((select sum(total) from v where to_char(v.dia, 'YYYY-MM') = m.mes), 0),
        'ventas', (select count(*) from v where to_char(v.dia, 'YYYY-MM') = m.mes)) order by m.mes), '[]') from meses m),
    'cobros_mes', (select coalesce(jsonb_agg(jsonb_build_object('mes', m.mes,
        'cobrado', coalesce((select sum(importe) from pagos where to_char(pagos.dia, 'YYYY-MM') = m.mes), 0),
        'devuelto', coalesce((select sum(importe) from devol where to_char(devol.dia, 'YYYY-MM') = m.mes), 0)) order by m.mes), '[]') from meses m),
    'periodo', jsonb_build_object(
        'ventas_total', (select coalesce(sum(total), 0) from vr),
        'num_ventas', (select count(*) from vr),
        'descuentos', (select coalesce(sum(descuento), 0) from vr),
        'cobrado', (select coalesce(sum(importe), 0) from pagos, par where pagos.dia between par.desde and par.hasta),
        'devoluciones', (select coalesce(sum(importe), 0) from devol, par where devol.dia between par.desde and par.hasta),
        'por_cerrar', (select count(*) from vr where saldo = 0 and not cerrada)),
    'capital', jsonb_build_object(
        'cxc', (select coalesce(sum(saldo), 0) from v where saldo > 0),
        'cxc_vencida', (select coalesce(sum(saldo), 0) from v where saldo > 0 and tipo = 'credito'
                          and vencimiento < (now() at time zone 'America/Mexico_City')::date),
        'num_con_saldo', (select count(*) from v where saldo > 0),
        'inventario', (select coalesce(sum(greatest(e.cantidad, 0) * coalesce(nullif(pr.costo_promedio, 0), pr.ultimo_costo, 0)), 0)
                         from existencias e join productos pr on pr.id = e.producto_id
                         join almacenes a on a.id = e.almacen_id, par
                        where par.suc is null or a.sucursal_id = par.suc),
        'saldo_favor', (select coalesce(sum(saldo_a_favor), 0) from clientes)),
    'categorias', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select categoria, sum(total) total from partidas group by categoria) x),
    'productos', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (select * from prod order by total desc limit 10) x),
    'productos_cantidad', (select coalesce(jsonb_agg(x order by x.medida desc), '[]') from (select * from prod order by medida desc limit 10) x),
    'sucursales', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select s.codigo || ' - ' || s.nombre sucursal, sum(vr.total) total, count(*) ventas
          from vr join sucursales s on s.id = vr.sucursal_id group by s.codigo, s.nombre) x),
    'vendedores', (select coalesce(jsonb_agg(x order by x.total desc), '[]') from (
        select vendedor_id, sum(total) total, count(*) ventas from vr group by vendedor_id) x)
  );
$$;
revoke execute on function public.tablero(jsonb) from public, anon;
grant execute on function public.tablero(jsonb) to authenticated;
