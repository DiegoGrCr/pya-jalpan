-- =============================================================================
-- 0043 · Corte de caja con fechas elegidas (lunes a viernes, lunes a sábado, sábado a sábado…).
-- corte_resumen y cerrar_corte aceptan {desde, hasta} (fechas, hora del centro de México):
--   · desde: 00:00 de ese día, pero nunca antes de que termine el último corte (no se cuenta dos veces).
--   · hasta: fin de ese día (sin pasar de ahora). Lo posterior queda para el siguiente corte.
--   · retiros y gastos entran según su fecha; al cerrar solo se ligan los del periodo.
-- Un retiro/gasto no puede fecharse dentro de un corte ya cerrado.
-- Requiere 0042. Se puede ejecutar más de una vez.
-- =============================================================================
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
  insert into retiros_caja (sucursal_id, importe, concepto, usuario_id, idempotency_key, tipo, categoria, forma, proveedor, fecha)
  values ((p->>'sucursal_id')::uuid, v_imp, trim(p->>'concepto'), auth.uid(), p->>'idempotency_key', v_tipo,
          nullif(trim(p->>'categoria'), ''), v_forma, nullif(trim(p->>'proveedor'), ''),
          -- un gasto se puede anotar con la fecha en que se pagó (no futura, dentro del corte abierto)
          v_fecha)
  returning id into v_id;
  perform registrar_bitacora(v_tipo, 'retiros_caja', v_id::text, null, p);
  return jsonb_build_object('retiro_id', v_id, 'repetida', false);
end $$;

create or replace function public.corte_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_desde timestamptz; v_hasta timestamptz := now(); v_ultimo timestamptz; v_lim timestamptz; v_ent jsonb; v_sal jsonb; v_ret jsonb;
        v_total numeric; v_efectivo numeric; v_gas jsonb; v_ven jsonb;
begin
  perform exigir(opera_sucursal(v_suc), 'No puedes ver el corte de esta sucursal');
  select max(hasta) into v_ultimo from cortes_caja where sucursal_id = v_suc;
  if nullif(p->>'desde', '') is not null then
    -- inicio elegido: 00:00 de ese día (hora del centro), nunca antes de que termine el último corte
    v_desde := greatest((p->>'desde')::date::timestamp at time zone 'America/Mexico_City', coalesce(v_ultimo, '-infinity'));
  else
    -- por omisión: donde terminó el último corte; primer corte: desde la primera venta (un segundo antes)
    v_desde := coalesce(v_ultimo, (select least(coalesce(min(fecha), now()), now()) - interval '1 second' from ventas where sucursal_id = v_suc));
  end if;
  if nullif(p->>'hasta', '') is not null then
    -- fin elegido: fin de ese día, sin pasar de ahora
    v_hasta := least(((p->>'hasta')::date + 1)::timestamp at time zone 'America/Mexico_City' - interval '1 microsecond', now());
  end if;
  perform exigir(v_hasta > v_desde, 'La fecha final debe ser posterior al inicio del corte');
  -- retiros/gastos: los de su fecha en el periodo; en el primer corte sin inicio elegido, todos los anteriores
  v_lim := case when v_ultimo is null and nullif(p->>'desde', '') is null then '-infinity'::timestamptz else v_desde end;

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
    into v_ret from retiros_caja r where r.sucursal_id = v_suc and r.corte_id is null and not r.cancelado and r.tipo = 'retiro'
                                and r.fecha > v_lim and r.fecha <= v_hasta;

  -- Gastos del corte (cualquier forma de pago; los de efectivo salen de la caja)
  select coalesce(jsonb_agg(jsonb_build_object('id', g.id, 'fecha', g.fecha, 'importe', g.importe, 'concepto', g.concepto, 'categoria', g.categoria,
                  'forma', g.forma, 'proveedor', g.proveedor, 'usuario', (select nombre from perfiles where user_id = g.usuario_id)) order by g.fecha), '[]')
    into v_gas from retiros_caja g where g.sucursal_id = v_suc and g.corte_id is null and not g.cancelado and g.tipo = 'gasto'
                                and g.fecha > v_lim and g.fecha <= v_hasta;

  v_ven := corte_ventas_periodo(v_suc, v_desde, v_hasta);

  v_total := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x), 0)
           - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x), 0);
  v_efectivo := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_gas) x where x->>'forma' = 'efectivo'), 0);

  return jsonb_build_object('sucursal_id', v_suc, 'desde', v_desde, 'hasta', v_hasta, 'ultimo_corte', v_ultimo, 'entradas', v_ent, 'salidas', v_sal, 'retiros', v_ret,
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

create or replace function public.cerrar_corte(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_res jsonb; v_id uuid; v_serie text; v_folio bigint; v_contado numeric := round(nullif(p->>'efectivo_contado','')::numeric, 2);
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('corte:' || v_suc::text, 0));
  select id into v_id from cortes_caja where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('corte_id', v_id, 'repetida', true); end if;
  perform exigir(v_contado is not null and v_contado >= 0, 'Escribe el efectivo contado');
  v_res := corte_resumen(jsonb_build_object('sucursal_id', v_suc, 'desde', p->>'desde', 'hasta', p->>'hasta'));
  -- Si la sucursal no tiene serie de cortes, se crea (código de sucursal + X)
  insert into series (sucursal_id, tipo_documento, prefijo)
  select v_suc, 'corte', su.codigo || 'X' from sucursales su
   where su.id = v_suc and not exists (select 1 from series where sucursal_id = v_suc and tipo_documento = 'corte' and activa)
  on conflict do nothing;
  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'corte') s;
  insert into cortes_caja (sucursal_id, serie, folio, desde, hasta, resumen, total_general, efectivo_esperado, efectivo_contado, diferencia, notas, usuario_id, idempotency_key)
  values (v_suc, v_serie, v_folio, (v_res->>'desde')::timestamptz, (v_res->>'hasta')::timestamptz, v_res, (v_res->>'total_general')::numeric,
          (v_res->>'efectivo_esperado')::numeric, v_contado, v_contado - (v_res->>'efectivo_esperado')::numeric,
          nullif(trim(p->>'notas'), ''), auth.uid(), p->>'idempotency_key')
  returning id into v_id;
  -- solo los retiros y gastos que entraron en este corte (los posteriores quedan para el siguiente)
  update retiros_caja set corte_id = v_id
   where id in (select (x->>'id')::uuid from jsonb_array_elements(v_res->'retiros') x
                union all select (x->>'id')::uuid from jsonb_array_elements(v_res->'gastos') x);
  perform registrar_bitacora('corte', 'cortes_caja', v_id::text, null, jsonb_build_object('total', v_res->>'total_general', 'contado', v_contado));
  return jsonb_build_object('corte_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

revoke execute on function public.registrar_retiro(jsonb), public.corte_resumen(jsonb), public.cerrar_corte(jsonb) from public, anon;
grant execute on function public.registrar_retiro(jsonb), public.corte_resumen(jsonb), public.cerrar_corte(jsonb) to authenticated;
