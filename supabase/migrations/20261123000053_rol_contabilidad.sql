-- =============================================================================
-- Rol Contabilidad / Facturación (clave 'facturacion'): ve TODAS las sucursales y no opera nada.
--  * ve_sucursal / ve_almacen: lectura (quien opera la sucursal, o contabilidad).
--  * opera_sucursal / opera_almacen: escritura; contabilidad nunca opera (aunque tenga sucursales asignadas).
--  * Las políticas de lectura pasan a usar ve_* ; corte_resumen e historial_venta también.
--  * No da de alta ni edita clientes. Ve costos y utilidad (ver_costos).
-- Se puede ejecutar más de una vez.
-- =============================================================================
begin;

create or replace function public.es_contabilidad()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and activo and rol = 'facturacion');
$$;

create or replace function public.opera_sucursal(p_sucursal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.es_contabilidad() and (public.es_admin() or exists (
    select 1 from usuario_sucursales us join perfiles pf on pf.user_id = us.user_id
     where us.user_id = auth.uid() and pf.activo and us.sucursal_id = p_sucursal));
$$;

create or replace function public.opera_almacen(p_almacen uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.es_contabilidad() and exists (
    select 1 from almacenes a
     where a.id = p_almacen and a.activo
       and (public.opera_sucursal(a.sucursal_id)
            or (a.multisucursal and exists (
                  select 1 from usuario_sucursales us where us.user_id = auth.uid()))));
$$;

-- Lectura
create or replace function public.ve_sucursal(p_sucursal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.es_contabilidad() or public.opera_sucursal(p_sucursal);
$$;
create or replace function public.ve_almacen(p_almacen uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.es_contabilidad() or public.opera_almacen(p_almacen);
$$;
grant execute on function public.es_contabilidad(), public.ve_sucursal(uuid), public.ve_almacen(uuid) to authenticated;

-- Todas las políticas de LECTURA que dependían de operar la sucursal/almacén pasan a ve_*
do $$
declare pol record; v_q text;
begin
  for pol in select tablename, policyname, qual from pg_policies
              where schemaname = 'public' and cmd = 'SELECT' and qual ~ 'opera_(sucursal|almacen)\(' loop
    v_q := regexp_replace(pol.qual, 'opera_(sucursal|almacen)\(', 've_\1(', 'g');
    execute format('alter policy %I on public.%I using (%s)', pol.policyname, pol.tablename, v_q);
  end loop;
end $$;

-- Clientes: contabilidad solo consulta
alter policy clientes_ins on public.clientes
  with check (exists (select 1 from public.perfiles where user_id = auth.uid() and activo) and not public.es_contabilidad());
alter policy clientes_upd on public.clientes
  using (exists (select 1 from public.perfiles where user_id = auth.uid() and activo) and not public.es_contabilidad())
  with check (exists (select 1 from public.perfiles where user_id = auth.uid() and activo) and not public.es_contabilidad());

-- Costos y utilidad
insert into public.rol_permisos (rol, permiso) values ('facturacion', 'ver_costos') on conflict do nothing;

create or replace function public.corte_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_desde timestamptz; v_hasta timestamptz := now(); v_ultimo timestamptz; v_lim timestamptz; v_ent jsonb; v_sal jsonb; v_ret jsonb;
        v_total numeric; v_efectivo numeric; v_gas jsonb; v_ven jsonb;
begin
  perform exigir(ve_sucursal(v_suc), 'No puedes ver el corte de esta sucursal');
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

create or replace function public.historial_venta(p_venta uuid)
returns table (fecha timestamptz, accion text, usuario text, detalle jsonb)
language sql stable security definer set search_path = public as $$
  select b.fecha, b.accion, coalesce(pf.nombre, ''), coalesce(b.despues, '{}'::jsonb) || jsonb_build_object('antes', b.antes)
    from bitacora b left join perfiles pf on pf.user_id = b.user_id
   where b.entidad = 'ventas' and b.entidad_id = p_venta::text
     and exists (select 1 from ventas v where v.id = p_venta and ve_sucursal(v.sucursal_id))
   order by b.fecha;
$$;

commit;
