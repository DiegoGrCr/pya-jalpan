-- =============================================================================
-- Gastos con o sin factura: al registrar un gasto se marca si trae factura y su folio fiscal (UUID),
-- para separar lo deducible. El resumen contable suma los gastos con factura.
-- Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.retiros_caja add column if not exists con_factura boolean not null default false;
alter table public.retiros_caja add column if not exists factura_folio text;

create or replace function public.registrar_retiro(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_fecha timestamptz := least(coalesce(nullif(p->>'fecha','')::timestamptz, now()), now()); v_imp numeric := round(nullif(p->>'importe','')::numeric, 2);
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
  perform exigir(v_fecha > coalesce((select max(hasta) from cortes_caja where sucursal_id = (p->>'sucursal_id')::uuid), '-infinity'),
                'Esa fecha ya está en un corte cerrado');
  insert into retiros_caja (sucursal_id, importe, concepto, usuario_id, idempotency_key, tipo, categoria, forma, proveedor, fecha, con_factura, factura_folio)
  values ((p->>'sucursal_id')::uuid, v_imp, trim(p->>'concepto'), auth.uid(), p->>'idempotency_key', v_tipo,
          nullif(trim(p->>'categoria'), ''), v_forma, nullif(trim(p->>'proveedor'), ''),
          -- un gasto se puede anotar con la fecha en que se pagó (no futura, dentro del corte abierto)
          v_fecha,
          v_tipo = 'gasto' and coalesce((p->>'con_factura')::boolean, false),
          case when v_tipo = 'gasto' and coalesce((p->>'con_factura')::boolean, false) then nullif(upper(trim(p->>'factura_folio')), '') end)
  returning id into v_id;
  perform registrar_bitacora(v_tipo, 'retiros_caja', v_id::text, null, p);
  return jsonb_build_object('retiro_id', v_id, 'repetida', false);
end $$;

create or replace function public.resumen_contable(p jsonb)
returns jsonb language plpgsql stable security invoker set search_path = public as $$
declare
  v_desde date := coalesce(nullif(p->>'desde','')::date, date_trunc('month', now() at time zone 'America/Mexico_City')::date);
  v_hasta date := coalesce(nullif(p->>'hasta','')::date, (now() at time zone 'America/Mexico_City')::date);
  v_suc uuid := nullif(p->>'sucursal_id','')::uuid;
  d0 timestamptz; d1 timestamptz; hoy date := (now() at time zone 'America/Mexico_City')::date;
  costos boolean := tiene_permiso('ver_costos');
  s record; v_res jsonb := '[]';
  v_ven jsonb; v_cob jsonb; v_dev jsonb; v_gas jsonb; v_cor jsonb; v_cxc jsonb; v_apa jsonb; v_inv numeric; v_costo numeric; v_ret numeric;
begin
  perform exigir(v_hasta >= v_desde, 'La fecha final debe ser igual o posterior a la inicial');
  perform exigir(v_hasta - v_desde <= 400, 'El periodo máximo es de un año');
  d0 := v_desde::timestamp at time zone 'America/Mexico_City';
  d1 := (v_hasta + 1)::timestamp at time zone 'America/Mexico_City';

  for s in select su.id, su.codigo, su.nombre from sucursales su
            where (v_suc is null or su.id = v_suc) and ve_sucursal(su.id) order by su.codigo loop

    select jsonb_build_object(
        'num', count(*) filter (where estado = 'confirmada'),
        'canceladas', count(*) filter (where estado = 'cancelada'),
        'total_canceladas', coalesce(sum(total) filter (where estado = 'cancelada'), 0),
        'subtotal', coalesce(sum(subtotal) filter (where estado = 'confirmada'), 0),
        'descuento', coalesce(sum(descuento) filter (where estado = 'confirmada'), 0),
        'iva', coalesce(sum(iva) filter (where estado = 'confirmada'), 0),
        'ieps', coalesce(sum(ieps) filter (where estado = 'confirmada'), 0),
        'total', coalesce(sum(total) filter (where estado = 'confirmada'), 0),
        'contado', coalesce(sum(total) filter (where estado = 'confirmada' and tipo = 'contado'), 0),
        'credito', coalesce(sum(total) filter (where estado = 'confirmada' and tipo = 'credito'), 0),
        'con_iva', count(*) filter (where estado = 'confirmada' and iva > 0),
        'publico_general', coalesce(sum(v.total) filter (where estado = 'confirmada' and c.es_publico_general), 0),
        'clientes_registrados', coalesce(sum(v.total) filter (where estado = 'confirmada' and not c.es_publico_general), 0))
      into v_ven
      from ventas v join clientes c on c.id = v.cliente_id
     where v.sucursal_id = s.id and v.fecha >= d0 and v.fecha < d1;

    v_costo := null;
    if costos then
      -- sin lo devuelto: (cantidad − devuelta) en unidad base × costo
      select coalesce(sum(round((vp.cantidad - vp.cantidad_devuelta) * vp.factor * vp.costo_unitario_base, 2)), 0) into v_costo
        from venta_partidas vp join ventas v on v.id = vp.venta_id
       where v.sucursal_id = s.id and v.estado = 'confirmada' and v.fecha >= d0 and v.fecha < d1;
    end if;

    -- Dinero que entró en el periodo, por forma (ventas, apartados y abonos a saldo a favor)
    with e as (
      select pg.forma, pg.importe from venta_pagos pg join ventas v on v.id = pg.venta_id
       where v.sucursal_id = s.id and v.estado = 'confirmada' and pg.forma not in ('saldo_favor','anticipo') and pg.fecha >= d0 and pg.fecha < d1
      union all
      select ap.forma, ap.importe from apartado_pagos ap join apartados a on a.id = ap.apartado_id
       where a.sucursal_id = s.id and ap.tipo in ('anticipo','abono') and ap.fecha >= d0 and ap.fecha < d1
      union all
      select m.forma, m.importe from saldo_favor_movimientos m
       where m.sucursal_id = s.id and m.forma is not null and m.importe > 0 and m.fecha >= d0 and m.fecha < d1)
    select coalesce(jsonb_object_agg(forma, total), '{}') into v_cob from (select forma, sum(importe) total from e group by forma) x;

    -- Devoluciones: dinero regresado por forma y lo que quedó como saldo a favor
    with d as (
      select dv.forma, dv.importe from venta_devoluciones dv join ventas v on v.id = dv.venta_id
       where v.sucursal_id = s.id and dv.fecha >= d0 and dv.fecha < d1
      union all
      select ap.forma, ap.importe from apartado_pagos ap join apartados a on a.id = ap.apartado_id
       where a.sucursal_id = s.id and ap.tipo = 'devolucion' and ap.fecha >= d0 and ap.fecha < d1)
    select jsonb_build_object(
      'dinero', (select coalesce(jsonb_object_agg(forma, total), '{}') from (select forma, sum(importe) total from d group by forma) x),
      'saldo_favor', (select coalesce(sum(dp.importe), 0) from devoluciones_producto dp join ventas v on v.id = dp.venta_id
                       where v.sucursal_id = s.id and dp.destino = 'saldo_favor' and dp.fecha >= d0 and dp.fecha < d1),
      'productos', (select coalesce(sum(dp.importe), 0) from devoluciones_producto dp join ventas v on v.id = dp.venta_id
                     where v.sucursal_id = s.id and dp.fecha >= d0 and dp.fecha < d1))
      into v_dev;

    select jsonb_build_object(
      'total', coalesce(sum(importe), 0),
      'con_factura', coalesce(sum(importe) filter (where con_factura), 0),
      'categorias', coalesce((select jsonb_agg(jsonb_build_object('categoria', categoria, 'importe', imp) order by imp desc)
                                from (select coalesce(categoria, 'Sin categoría') categoria, sum(importe) imp from retiros_caja
                                       where sucursal_id = s.id and tipo = 'gasto' and not cancelado and fecha >= d0 and fecha < d1
                                       group by 1) g), '[]'),
      'por_forma', coalesce((select jsonb_object_agg(forma, imp) from (select forma, sum(importe) imp from retiros_caja
                                where sucursal_id = s.id and tipo = 'gasto' and not cancelado and fecha >= d0 and fecha < d1 group by forma) f), '{}'))
      into v_gas
      from retiros_caja where sucursal_id = s.id and tipo = 'gasto' and not cancelado and fecha >= d0 and fecha < d1;

    select coalesce(sum(importe), 0) into v_ret from retiros_caja
     where sucursal_id = s.id and tipo = 'retiro' and not cancelado and fecha >= d0 and fecha < d1;

    select jsonb_build_object('num', count(*), 'total', coalesce(sum(total_general), 0), 'diferencia', coalesce(sum(diferencia), 0),
                              'con_diferencia', count(*) filter (where diferencia <> 0))
      into v_cor from cortes_caja where sucursal_id = s.id and hasta >= d0 and hasta < d1;

    -- Al día de hoy
    select jsonb_build_object('saldo', coalesce(sum(saldo), 0), 'vencido', coalesce(sum(saldo) filter (where vencimiento < hoy), 0),
                              'notas', count(*))
      into v_cxc from ventas where sucursal_id = s.id and estado = 'confirmada' and saldo > 0;
    select jsonb_build_object('num', count(*), 'total', coalesce(sum(total), 0), 'saldo', coalesce(sum(saldo), 0))
      into v_apa from apartados where sucursal_id = s.id and estado = 'abierto';
    v_inv := null;
    if costos then
      select coalesce(sum(round(greatest(e.cantidad, 0) * coalesce(pr.costo_promedio, 0), 2)), 0) into v_inv
        from existencias e join almacenes al on al.id = e.almacen_id join productos pr on pr.id = e.producto_id
       where al.sucursal_id = s.id and pr.tipo = 'producto';
    end if;

    v_res := v_res || jsonb_build_object('sucursal_id', s.id, 'codigo', s.codigo, 'nombre', s.nombre,
      'ventas', v_ven, 'ventas_netas', (v_ven->>'subtotal')::numeric - (v_dev->>'productos')::numeric,
      'costo', v_costo, 'utilidad', case when v_costo is null then null else (v_ven->>'subtotal')::numeric - (v_dev->>'productos')::numeric - v_costo end,
      'cobranza', v_cob, 'devoluciones', v_dev, 'gastos', v_gas, 'retiros', v_ret, 'cortes', v_cor,
      'por_cobrar', v_cxc, 'apartados', v_apa, 'inventario', v_inv);
  end loop;

  return jsonb_build_object('desde', v_desde, 'hasta', v_hasta, 'costos', costos, 'sucursales', v_res);
end $$;

revoke execute on function public.resumen_contable(jsonb) from public, anon;
grant execute on function public.resumen_contable(jsonb) to authenticated;
