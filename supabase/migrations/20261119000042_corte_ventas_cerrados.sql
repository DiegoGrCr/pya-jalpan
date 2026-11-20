-- =============================================================================
-- 0042 · Detalle de ventas también en los cortes ya cerrados.
-- Los cortes cerrados antes de 0041 no guardaron la lista de ventas (folio, cliente, cobrado por forma,
-- estatus); aquí se reconstruye para su periodo y se agrega a su resumen. Incluye lo de 0041, así que
-- funciona aunque 0041 no se haya ejecutado. Requiere 0040. Se puede ejecutar más de una vez.
-- =============================================================================

-- Ventas de una sucursal en un periodo de corte: las hechas en el periodo (incluso canceladas) y las
-- anteriores que recibieron pagos en él. "pagos" = lo cobrado de esa venta en el periodo, por forma.
create or replace function public.corte_ventas_periodo(p_suc uuid, p_desde timestamptz, p_hasta timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', v.id, 'serie', v.serie, 'folio', v.folio, 'fecha', v.fecha, 'tipo', v.tipo, 'estado', v.estado,
           'cliente', coalesce(nullif(c.razon_social, ''), c.nombre), 'total', v.total, 'saldo', v.saldo,
           'anterior', v.fecha <= p_desde,
           'pagos', case when v.estado = 'cancelada' then '{}'::jsonb else coalesce((
              select jsonb_object_agg(forma, imp) from (select pg.forma, sum(pg.importe) imp from venta_pagos pg
                where pg.venta_id = v.id and pg.fecha > p_desde and pg.fecha <= p_hasta group by pg.forma) z), '{}'::jsonb) end)
         order by v.fecha <= p_desde, v.serie, v.folio desc), '[]')
    from ventas v join clientes c on c.id = v.cliente_id
   where v.sucursal_id = p_suc
     and ((v.fecha > p_desde and v.fecha <= p_hasta)
          or exists (select 1 from venta_pagos pg where pg.venta_id = v.id and pg.fecha > p_desde and pg.fecha <= p_hasta));
$$;
revoke execute on function public.corte_ventas_periodo(uuid, timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.corte_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_desde timestamptz; v_hasta timestamptz := now(); v_ent jsonb; v_sal jsonb; v_ret jsonb;
        v_total numeric; v_efectivo numeric; v_gas jsonb; v_ven jsonb;
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

  v_ven := corte_ventas_periodo(v_suc, v_desde, v_hasta);

  v_total := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x), 0)
           - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x), 0);
  v_efectivo := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x where x->>'forma' = 'efectivo'), 0);

  return jsonb_build_object('sucursal_id', v_suc, 'desde', v_desde, 'hasta', v_hasta, 'entradas', v_ent, 'salidas', v_sal, 'retiros', v_ret,
    'retirado', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0),
    'gastos', v_gas, 'ventas', v_ven,
    'gastado', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x), 0),
    'gastado_efectivo', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x where x->>'forma' = 'efectivo'), 0),
    'neto', v_total - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x), 0),
    'total_general', v_total, 'efectivo_esperado', v_efectivo,
    'por_forma', (select coalesce(jsonb_object_agg(forma, total), '{}') from (
        select forma, sum(case when signo then importe else -importe end) total from (
          select (x->>'forma') forma, (x->>'importe')::numeric importe, true signo from jsonb_array_elements(v_ent) x
          union all select (x->>'forma'), (x->>'importe')::numeric, false from jsonb_array_elements(v_sal) x) z group by forma) y));
end $$;

revoke execute on function public.corte_resumen(jsonb) from public, anon;
grant execute on function public.corte_resumen(jsonb) to authenticated;

-- Cortes ya cerrados sin detalle de ventas: reconstruirlo para su periodo
update public.cortes_caja
   set resumen = resumen || jsonb_build_object('ventas', public.corte_ventas_periodo(sucursal_id, desde, hasta))
 where not (resumen ? 'ventas');
