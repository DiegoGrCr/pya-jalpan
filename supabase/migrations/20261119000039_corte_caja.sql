-- =============================================================================
-- 0039 · Corte de caja (por sucursal, normalmente semanal) y retiros de efectivo
-- - Retiros: durante el periodo se registran retiros de efectivo (importe y concepto); quedan dentro
--   del corte siguiente.
-- - corte_resumen(p): lo que va del corte en curso (desde el último corte de la sucursal):
--   entradas por forma de pago (ventas, pagos posteriores, anticipos/abonos de apartados, abonos a
--   saldo a favor), devoluciones de dinero y retiros. Total general y total en efectivo esperado.
-- - cerrar_corte(p): guarda el corte con su folio, el efectivo contado y la diferencia.
-- No cuentan como dinero: pagos con "saldo a favor" ni "anticipo de apartado" al liquidar (ya entraron antes).
-- Requiere 0038. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.saldo_favor_movimientos add column if not exists sucursal_id uuid references public.sucursales(id);

create table if not exists public.retiros_caja (
  id          uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id),
  fecha       timestamptz not null default now(),
  importe     numeric(14,2) not null check (importe > 0),
  concepto    text not null,
  usuario_id  uuid,
  corte_id    uuid,
  cancelado   boolean not null default false,
  idempotency_key text unique
);
create table if not exists public.cortes_caja (
  id              uuid primary key default gen_random_uuid(),
  sucursal_id     uuid not null references public.sucursales(id),
  serie           text not null,
  folio           bigint not null,
  desde           timestamptz not null,
  hasta           timestamptz not null,
  resumen         jsonb not null,
  total_general   numeric(14,2) not null,
  efectivo_esperado numeric(14,2) not null,
  efectivo_contado  numeric(14,2) not null,
  diferencia      numeric(14,2) not null,
  notas           text,
  usuario_id      uuid,
  idempotency_key text unique,
  unique (sucursal_id, serie, folio)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'retiros_caja_corte_fk') then
    alter table public.retiros_caja add constraint retiros_caja_corte_fk foreign key (corte_id) references public.cortes_caja(id);
  end if;
end $$;

alter table public.retiros_caja enable row level security;
alter table public.cortes_caja  enable row level security;
drop policy if exists retiros_caja_sel on public.retiros_caja;
create policy retiros_caja_sel on public.retiros_caja for select to authenticated using (public.opera_sucursal(sucursal_id));
drop policy if exists cortes_caja_sel on public.cortes_caja;
create policy cortes_caja_sel on public.cortes_caja for select to authenticated using (public.opera_sucursal(sucursal_id));
grant select on public.retiros_caja, public.cortes_caja to authenticated;

-- abonar_saldo_favor guarda la sucursal (para el corte)
create or replace function public.abonar_saldo_favor(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_cli clientes%rowtype; v_imp numeric := round(nullif(p->>'importe','')::numeric, 2); v_saldo numeric; v_id uuid;
        v_suc uuid := nullif(p->>'sucursal_id','')::uuid;
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('favor:' || (p->>'idempotency_key'), 0));
  select id, saldo into v_id, v_saldo from saldo_favor_movimientos where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('movimiento_id', v_id, 'saldo', v_saldo, 'repetida', true); end if;
  perform exigir(exists (select 1 from perfiles where user_id = auth.uid() and activo), 'Usuario no autorizado');
  if v_suc is null then select sucursal_id into v_suc from usuario_sucursales where user_id = auth.uid() limit 1; end if;
  perform exigir(v_suc is not null and opera_sucursal(v_suc), 'Elige la sucursal donde se recibe el dinero');
  select * into v_cli from clientes where id = (p->>'cliente_id')::uuid;
  perform exigir(v_cli.id is not null and not v_cli.es_publico_general, 'Elige un cliente registrado');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');
  perform exigir(p->>'forma' in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Forma de pago no válida');
  v_saldo := mover_saldo_favor(v_cli.id, v_imp, null, coalesce(nullif(trim(p->>'concepto'), ''), 'Abono a saldo a favor'));
  update saldo_favor_movimientos set forma = p->>'forma', referencia = nullif(trim(p->>'referencia'), ''), idempotency_key = p->>'idempotency_key',
         sucursal_id = v_suc
   where id = (select id from saldo_favor_movimientos where cliente_id = v_cli.id order by fecha desc, id desc limit 1)
  returning id into v_id;
  return jsonb_build_object('movimiento_id', v_id, 'saldo', v_saldo, 'repetida', false);
end $$;

-- {sucursal_id, importe, concepto, idempotency_key}
create or replace function public.registrar_retiro(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_imp numeric := round(nullif(p->>'importe','')::numeric, 2);
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  select id into v_id from retiros_caja where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('retiro_id', v_id, 'repetida', true); end if;
  perform exigir(opera_sucursal((p->>'sucursal_id')::uuid), 'No puedes registrar retiros en esta sucursal');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');
  perform exigir(length(trim(coalesce(p->>'concepto',''))) > 0, 'Indica el concepto del retiro');
  insert into retiros_caja (sucursal_id, importe, concepto, usuario_id, idempotency_key)
  values ((p->>'sucursal_id')::uuid, v_imp, trim(p->>'concepto'), auth.uid(), p->>'idempotency_key') returning id into v_id;
  perform registrar_bitacora('retiro', 'retiros_caja', v_id::text, null, p);
  return jsonb_build_object('retiro_id', v_id, 'repetida', false);
end $$;

-- Cancela un retiro mientras no esté en un corte
create or replace function public.cancelar_retiro(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r retiros_caja%rowtype;
begin
  select * into r from retiros_caja where id = p_id for update;
  perform exigir(r.id is not null, 'Retiro no encontrado');
  perform exigir(opera_sucursal(r.sucursal_id), 'No puedes modificar retiros de esta sucursal');
  perform exigir(r.corte_id is null, 'El retiro ya está en un corte cerrado');
  update retiros_caja set cancelado = true where id = p_id;
  perform registrar_bitacora('cancelar', 'retiros_caja', p_id::text, to_jsonb(r), null);
end $$;

-- Resumen del corte en curso de una sucursal. p: {sucursal_id}
create or replace function public.corte_resumen(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_desde timestamptz; v_hasta timestamptz := now(); v_ent jsonb; v_sal jsonb; v_ret jsonb;
        v_total numeric; v_efectivo numeric;
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
    into v_ret from retiros_caja r where r.sucursal_id = v_suc and r.corte_id is null and not r.cancelado;

  v_total := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x), 0)
           - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x), 0);
  v_efectivo := coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ent) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_sal) x where x->>'forma' = 'efectivo'), 0)
              - coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0);

  return jsonb_build_object('sucursal_id', v_suc, 'desde', v_desde, 'hasta', v_hasta, 'entradas', v_ent, 'salidas', v_sal, 'retiros', v_ret,
    'retirado', coalesce((select sum((x->>'importe')::numeric) from jsonb_array_elements(v_ret) x), 0),
    'total_general', v_total, 'efectivo_esperado', v_efectivo,
    'por_forma', (select coalesce(jsonb_object_agg(forma, total), '{}') from (
        select forma, sum(case when signo then importe else -importe end) total from (
          select (x->>'forma') forma, (x->>'importe')::numeric importe, true signo from jsonb_array_elements(v_ent) x
          union all select (x->>'forma'), (x->>'importe')::numeric, false from jsonb_array_elements(v_sal) x) z group by forma) y));
end $$;

-- {sucursal_id, efectivo_contado, notas?, idempotency_key}
create or replace function public.cerrar_corte(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_suc uuid := (p->>'sucursal_id')::uuid; v_res jsonb; v_id uuid; v_serie text; v_folio bigint; v_contado numeric := round(nullif(p->>'efectivo_contado','')::numeric, 2);
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('corte:' || v_suc::text, 0));
  select id into v_id from cortes_caja where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('corte_id', v_id, 'repetida', true); end if;
  perform exigir(v_contado is not null and v_contado >= 0, 'Escribe el efectivo contado');
  v_res := corte_resumen(jsonb_build_object('sucursal_id', v_suc));
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
  update retiros_caja set corte_id = v_id where sucursal_id = v_suc and corte_id is null and not cancelado;
  perform registrar_bitacora('corte', 'cortes_caja', v_id::text, null, jsonb_build_object('total', v_res->>'total_general', 'contado', v_contado));
  return jsonb_build_object('corte_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

revoke execute on function public.registrar_retiro(jsonb), public.cancelar_retiro(uuid), public.corte_resumen(jsonb), public.cerrar_corte(jsonb),
  public.abonar_saldo_favor(jsonb) from public, anon;
grant execute on function public.registrar_retiro(jsonb), public.cancelar_retiro(uuid), public.corte_resumen(jsonb), public.cerrar_corte(jsonb),
  public.abonar_saldo_favor(jsonb) to authenticated;
