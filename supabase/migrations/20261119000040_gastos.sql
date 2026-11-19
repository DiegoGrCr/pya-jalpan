-- =============================================================================
-- 0040 · Gastos (por sucursal) en el corte de caja, en Finanzas › Gastos y en el tablero
-- Los movimientos de caja ahora son de dos tipos:
--   retiro: sacar efectivo (depósito, entrega al dueño); solo afecta el efectivo.
--   gasto : pago de algo del negocio (con categoría y forma de pago). Si es en efectivo sale de la
--           caja; si es por transferencia/tarjeta solo cuenta como gasto.
-- Requiere 0039 y 0034. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.retiros_caja add column if not exists tipo      text not null default 'retiro' check (tipo in ('retiro', 'gasto'));
alter table public.retiros_caja add column if not exists categoria text;
alter table public.retiros_caja add column if not exists forma     text not null default 'efectivo'
  check (forma in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'));
alter table public.retiros_caja add column if not exists proveedor text;

-- {sucursal_id, importe, concepto, idempotency_key, tipo?: 'retiro'|'gasto', categoria?, forma?, proveedor?, fecha?}
create or replace function public.registrar_retiro(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_imp numeric := round(nullif(p->>'importe','')::numeric, 2);
        v_tipo text := coalesce(nullif(p->>'tipo',''), 'retiro'); v_forma text := coalesce(nullif(p->>'forma',''), 'efectivo');
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  select id into v_id from retiros_caja where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('retiro_id', v_id, 'repetida', true); end if;
  perform exigir(opera_sucursal((p->>'sucursal_id')::uuid), 'No puedes registrar movimientos de caja en esta sucursal');
  perform exigir(v_tipo in ('retiro', 'gasto'), 'Tipo no válido');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');
  perform exigir(length(trim(coalesce(p->>'concepto',''))) > 0, 'Indica el concepto');
  perform exigir(v_tipo = 'gasto' or v_forma = 'efectivo', 'Un retiro siempre es de efectivo');
  perform exigir(v_tipo = 'retiro' or length(trim(coalesce(p->>'categoria',''))) > 0, 'Elige la categoría del gasto');
  insert into retiros_caja (sucursal_id, importe, concepto, usuario_id, idempotency_key, tipo, categoria, forma, proveedor, fecha)
  values ((p->>'sucursal_id')::uuid, v_imp, trim(p->>'concepto'), auth.uid(), p->>'idempotency_key', v_tipo,
          nullif(trim(p->>'categoria'), ''), v_forma, nullif(trim(p->>'proveedor'), ''),
          -- un gasto se puede anotar con la fecha en que se pagó (no futura, dentro del corte abierto)
          least(coalesce(nullif(p->>'fecha','')::timestamptz, now()), now()))
  returning id into v_id;
  perform registrar_bitacora(v_tipo, 'retiros_caja', v_id::text, null, p);
  return jsonb_build_object('retiro_id', v_id, 'repetida', false);
end $$;


-- corte_resumen: retiros y gastos por separado
create or replace function public.corte_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_desde timestamptz; v_hasta timestamptz := now(); v_ent jsonb; v_sal jsonb; v_ret jsonb;
        v_total numeric; v_efectivo numeric; v_gas jsonb;
begin
  perform exigir(opera_sucursal(v_suc), 'No puedes ver el corte de esta sucursal');
  select max(hasta) into v_desde from cortes_caja where sucursal_id = v_suc;
  -- Primer corte: desde la primera venta (un segundo antes, para incluirla)
  v_desde := coalesce(v_desde, (select least(coalesce(min(fecha), now()), now()) - interval '1 second' from ventas where sucursal_id = v_suc));

  -- Entradas de dinero por concepto y forma
  with e as (
    select 'Ventas y pagos' concepto, pg.forma, pg.importe
      from venta_pagos pg join ventas v on v.id = pg.venta_id
     where v.sucursal_id = v_suc and v.estado = 'confirmada' and pg.forma not in ('saldo_favor','anticipo')
       and pg.fecha > v_desde and pg.fecha <= v_hasta
    union all
    select 'Apartados (anticipos y abonos)', ap.forma, ap.importe
      from apartado_pagos ap join apartados a on a.id = ap.apartado_id
     where a.sucursal_id = v_suc and ap.tipo in ('anticipo','abono') and ap.fecha > v_desde and ap.fecha <= v_hasta
    union all
    select 'Abonos a saldo a favor', m.forma, m.importe
      from saldo_favor_movimientos m
     where m.sucursal_id = v_suc and m.forma is not null and m.importe > 0 and m.fecha > v_desde and m.fecha <= v_hasta
  )
  select coalesce(jsonb_agg(jsonb_build_object('concepto', concepto, 'forma', forma, 'importe', importe)), '[]')
    into v_ent from (select concepto, forma, sum(importe) importe from e group by concepto, forma order by concepto, forma) x;

  -- Salidas: devoluciones de dinero (ventas y apartados)
  with s as (
    select 'Devoluciones de ventas' concepto, d.forma, d.importe
      from venta_devoluciones d join ventas v on v.id = d.venta_id
     where v.sucursal_id = v_suc and d.fecha > v_desde and d.fecha <= v_hasta
    union all
    select 'Devoluciones de apartados', ap.forma, ap.importe
      from apartado_pagos ap join apartados a on a.id = ap.apartado_id
     where a.sucursal_id = v_suc and ap.tipo = 'devolucion' and ap.fecha > v_desde and ap.fecha <= v_hasta
  )
  select coalesce(jsonb_agg(jsonb_build_object('concepto', concepto, 'forma', forma, 'importe', importe)), '[]')
    into v_sal from (select concepto, forma, sum(importe) importe from s group by concepto, forma order by concepto, forma) x;

  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'fecha', r.fecha, 'importe', r.importe, 'concepto', r.concepto,
                  'usuario', (select nombre from perfiles where user_id = r.usuario_id)) order by r.fecha), '[]')
    into v_ret from retiros_caja r where r.sucursal_id = v_suc and r.corte_id is null and not r.cancelado and r.tipo = 'retiro';

  -- Gastos del corte (cualquier forma de pago; los de efectivo salen de la caja)
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'fecha', g.fecha, 'importe', g.importe, 'concepto', g.concepto, 'categoria', g.categoria,
                  'forma', g.forma, 'proveedor', g.proveedor, 'usuario', (select nombre from perfiles where user_id = g.usuario_id)) order by g.fecha), '[]')
    into v_gas from retiros_caja g where g.sucursal_id = v_suc and g.corte_id is null and not g.cancelado and g.tipo = 'gasto';

  v_total := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x), 0)
           - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x), 0);
  v_efectivo := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x where x->>'forma' = 'efectivo'), 0);

  return jsonb_build_object('sucursal_id', v_suc, 'desde', v_desde, 'hasta', v_hasta, 'entradas', v_ent, 'salidas', v_sal, 'retiros', v_ret,
    'retirado', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0),
    'gastos', v_gas,
    'gastado', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x), 0),
    'gastado_efectivo', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x where x->>'forma' = 'efectivo'), 0),
    'neto', v_total - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x), 0),
    'total_general', v_total, 'efectivo_esperado', v_efectivo,
    'por_forma', (select coalesce(jsonb_object_agg(forma, total), '{}') from (
        select forma, sum(case when signo then importe else -importe end) total from (
          select (x->>'forma') forma, (x->>'importe')::numeric importe, true signo from jsonb_array_elements(v_ent) x
          union all select (x->>'forma'), (x->>'importe')::numeric, false from jsonb_array_elements(v_sal) x) z group by forma) y));
end $$;

-- tablero: gastos del periodo
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
        'por_cerrar', (select count(*) from vr where saldo = 0 and not cerrada),
        'gastos', (select coalesce(sum(g.importe), 0) from retiros_caja g, par
                    where g.tipo = 'gasto' and not g.cancelado and (par.suc is null or g.sucursal_id = par.suc)
                      and (g.fecha at time zone 'America/Mexico_City')::date between par.desde and par.hasta)),
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

revoke execute on function public.registrar_retiro(jsonb), public.corte_resumen(jsonb), public.tablero(jsonb) from public, anon;
grant execute on function public.registrar_retiro(jsonb), public.corte_resumen(jsonb), public.tablero(jsonb) to authenticated;
