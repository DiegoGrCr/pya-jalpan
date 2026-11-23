-- =============================================================================
-- Agenda de envíos / pedidos.
-- Un envío programado para un día (y hora opcional) a un destino, con prioridad, contacto, chofer/vehículo
-- y notas; puede ligarse a una o varias notas de venta (para saber qué material va) o ser solo un viaje.
-- Lo ven TODOS los usuarios; lo crean y cambian los que operan (no Contabilidad). Cada cambio queda en la bitácora.
-- Se puede ejecutar más de una vez.
-- =============================================================================
begin;

create table if not exists public.envios (
  id               uuid primary key default gen_random_uuid(),
  numero           bigserial unique,
  sucursal_id      uuid references public.sucursales(id),          -- de dónde sale
  cliente_id       uuid references public.clientes(id),
  fecha            date not null,
  hora             text,                                            -- libre: "9:00", "en la mañana"…
  destino          text not null check (length(trim(destino)) > 0), -- p. ej. "Pinal de Amoles"
  direccion        text,
  contacto         text,
  telefono         text,
  prioridad        text not null default 'normal' check (prioridad in ('baja','normal','alta','urgente')),
  estado           text not null default 'programado' check (estado in ('programado','en_ruta','entregado','cancelado')),
  chofer           text,
  vehiculo         text,
  contenido        text,                                            -- qué se lleva si no hay notas ligadas (o algo extra)
  notas            text,
  creado_por       uuid default auth.uid(),
  creado_en        timestamptz not null default now(),
  actualizado_por  uuid,
  actualizado_en   timestamptz,
  entregado_en     timestamptz,
  entregado_por    uuid,
  recibio          text,                                            -- quién recibió en destino
  motivo_cancelacion text,
  idempotency_key  text unique
);
create index if not exists envios_fecha on public.envios (fecha, estado);

create table if not exists public.envio_ventas (
  envio_id uuid not null references public.envios(id) on delete cascade,
  venta_id uuid not null references public.ventas(id),
  primary key (envio_id, venta_id)
);
create index if not exists envio_ventas_venta on public.envio_ventas (venta_id);

alter table public.envios enable row level security;
alter table public.envio_ventas enable row level security;
revoke all on public.envios, public.envio_ventas from anon;
revoke insert, update, delete, truncate on public.envios, public.envio_ventas from authenticated;
grant select on public.envios, public.envio_ventas to authenticated;
drop policy if exists envios_sel on public.envios;
create policy envios_sel on public.envios for select to authenticated
  using (exists (select 1 from public.perfiles where user_id = auth.uid() and activo));
drop policy if exists envio_ventas_sel on public.envio_ventas;
create policy envio_ventas_sel on public.envio_ventas for select to authenticated
  using (exists (select 1 from public.perfiles where user_id = auth.uid() and activo));

-- Notas ligadas a envíos: datos mínimos para todos (folio, cliente, total, saldo, si falta entregar material),
-- aunque la nota sea de otra sucursal.
create or replace function public.envio_notas(p_envios uuid[])
returns table (envio_id uuid, venta_id uuid, serie text, folio bigint, cliente text, total numeric, saldo numeric, estado text, por_entregar boolean, sucursal text)
language sql stable security definer set search_path = public as $$
  select ev.envio_id, v.id, v.serie, v.folio, coalesce(c.razon_social, c.nombre), v.total, v.saldo, v.estado,
         exists (select 1 from venta_partidas vp where vp.venta_id = v.id and vp.cantidad_entregada < vp.cantidad), su.codigo
    from envio_ventas ev join ventas v on v.id = ev.venta_id join clientes c on c.id = v.cliente_id join sucursales su on su.id = v.sucursal_id
   where ev.envio_id = any(p_envios)
     and exists (select 1 from perfiles where user_id = auth.uid() and activo)
   order by v.fecha;
$$;

-- Crear o editar. p = {id?, idempotency_key, fecha, hora, destino, direccion, contacto, telefono, prioridad, sucursal_id,
--                     cliente_id, chofer, vehiculo, contenido, notas, ventas:[venta_id]}
create or replace function public.guardar_envio(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_antes envios%rowtype; v_cli uuid := nullif(p->>'cliente_id','')::uuid; v_ex uuid;
begin
  perform exigir(exists (select 1 from perfiles where user_id = auth.uid() and activo), 'Usuario no autorizado');
  perform exigir(not es_contabilidad(), 'Tu usuario es de solo consulta');
  perform exigir(nullif(p->>'fecha','') is not null, 'Indica el día del envío');
  perform exigir(length(trim(coalesce(p->>'destino',''))) > 0, 'Indica el destino');
  perform exigir(coalesce(p->>'prioridad','normal') in ('baja','normal','alta','urgente'), 'Prioridad no válida');
  perform exigir(jsonb_array_length(coalesce(p->'ventas','[]')) > 0 or length(trim(coalesce(p->>'contenido',''))) > 0,
                 'Liga al menos una nota o describe qué se envía');
  -- el cliente, si no se indica, es el de la primera nota (si no es Público en general)
  if v_cli is null then
    select v.cliente_id into v_cli from ventas v join clientes c on c.id = v.cliente_id
     where v.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ventas','[]')) x) and not c.es_publico_general limit 1;
  end if;

  if v_id is null then
    select id into v_ex from envios where idempotency_key = p->>'idempotency_key';
    if v_ex is not null then return jsonb_build_object('envio_id', v_ex, 'repetida', true); end if;
    insert into envios (sucursal_id, cliente_id, fecha, hora, destino, direccion, contacto, telefono, prioridad, chofer, vehiculo, contenido, notas, idempotency_key)
    values (nullif(p->>'sucursal_id','')::uuid, v_cli, (p->>'fecha')::date, nullif(trim(p->>'hora'),''), trim(p->>'destino'), nullif(trim(p->>'direccion'),''),
            nullif(trim(p->>'contacto'),''), nullif(trim(p->>'telefono'),''), coalesce(p->>'prioridad','normal'), nullif(trim(p->>'chofer'),''),
            nullif(trim(p->>'vehiculo'),''), nullif(trim(p->>'contenido'),''), nullif(trim(p->>'notas'),''), p->>'idempotency_key')
    returning id into v_id;
    perform registrar_bitacora('crear', 'envios', v_id::text, null, p);
  else
    select * into v_antes from envios where id = v_id for update;
    perform exigir(v_antes.id is not null, 'Envío no encontrado');
    perform exigir(v_antes.estado in ('programado','en_ruta'), 'Un envío ' || v_antes.estado || ' ya no se edita');
    update envios set sucursal_id = nullif(p->>'sucursal_id','')::uuid, cliente_id = v_cli, fecha = (p->>'fecha')::date, hora = nullif(trim(p->>'hora'),''),
           destino = trim(p->>'destino'), direccion = nullif(trim(p->>'direccion'),''), contacto = nullif(trim(p->>'contacto'),''),
           telefono = nullif(trim(p->>'telefono'),''), prioridad = coalesce(p->>'prioridad','normal'), chofer = nullif(trim(p->>'chofer'),''),
           vehiculo = nullif(trim(p->>'vehiculo'),''), contenido = nullif(trim(p->>'contenido'),''), notas = nullif(trim(p->>'notas'),''),
           actualizado_por = auth.uid(), actualizado_en = now()
     where id = v_id;
    delete from envio_ventas where envio_id = v_id;
    perform registrar_bitacora('editar', 'envios', v_id::text, to_jsonb(v_antes), p);
  end if;

  insert into envio_ventas (envio_id, venta_id)
  select v_id, v.id from ventas v where v.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ventas','[]')) x)
  on conflict do nothing;
  return jsonb_build_object('envio_id', v_id, 'numero', (select numero from envios where id = v_id), 'repetida', false);
end $$;

-- Cambiar estado. p = {envio_id, estado: 'programado'|'en_ruta'|'entregado'|'cancelado', recibio?, motivo?}
create or replace function public.cambiar_estado_envio(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e envios%rowtype; v_est text := p->>'estado';
begin
  perform exigir(exists (select 1 from perfiles where user_id = auth.uid() and activo), 'Usuario no autorizado');
  perform exigir(not es_contabilidad(), 'Tu usuario es de solo consulta');
  select * into e from envios where id = nullif(p->>'envio_id','')::uuid for update;
  perform exigir(e.id is not null, 'Envío no encontrado');
  perform exigir(v_est in ('programado','en_ruta','entregado','cancelado'), 'Estado no válido');
  perform exigir(e.estado <> 'cancelado' or v_est = 'programado', 'El envío está cancelado');
  perform exigir(v_est <> 'cancelado' or length(trim(coalesce(p->>'motivo',''))) > 0, 'Indica el motivo de la cancelación');
  update envios set estado = v_est, actualizado_por = auth.uid(), actualizado_en = now(),
         entregado_en = case when v_est = 'entregado' then now() when v_est in ('programado','en_ruta') then null else entregado_en end,
         entregado_por = case when v_est = 'entregado' then auth.uid() when v_est in ('programado','en_ruta') then null else entregado_por end,
         recibio = case when v_est = 'entregado' then nullif(trim(p->>'recibio'),'') else recibio end,
         motivo_cancelacion = case when v_est = 'cancelado' then trim(p->>'motivo') when v_est = 'programado' then null else motivo_cancelacion end
   where id = e.id;
  perform registrar_bitacora('estado', 'envios', e.id::text, jsonb_build_object('estado', e.estado), p);
  return jsonb_build_object('envio_id', e.id, 'estado', v_est);
end $$;

-- Historial de un envío (para todos)
create or replace function public.historial_envio(p_envio uuid)
returns table (fecha timestamptz, accion text, usuario text, detalle jsonb)
language sql stable security definer set search_path = public as $$
  select b.fecha, b.accion, coalesce(pf.nombre, ''), coalesce(b.despues, '{}'::jsonb)
    from bitacora b left join perfiles pf on pf.user_id = b.user_id
   where b.entidad = 'envios' and b.entidad_id = p_envio::text
     and exists (select 1 from perfiles where user_id = auth.uid() and activo)
   order by b.fecha;
$$;

revoke execute on function public.envio_notas(uuid[]), public.guardar_envio(jsonb), public.cambiar_estado_envio(jsonb), public.historial_envio(uuid) from public, anon;
grant execute on function public.envio_notas(uuid[]), public.guardar_envio(jsonb), public.cambiar_estado_envio(jsonb), public.historial_envio(uuid) to authenticated;

commit;
