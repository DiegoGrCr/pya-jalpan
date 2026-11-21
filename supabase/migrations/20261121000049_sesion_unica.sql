-- =============================================================================
-- Una sola sesión abierta por usuario.
-- Cada navegador genera un identificador de sesión al entrar y "late" cada minuto.
-- Si el usuario ya tiene una sesión viva (latido en los últimos 3 minutos) en otro equipo,
-- el nuevo inicio de sesión se rechaza. Si el otro equipo se cerró sin salir, la sesión
-- caduca sola a los 3 minutos, o un administrador la cierra desde Configuración › Usuarios.
-- Se puede ejecutar más de una vez.
-- =============================================================================
begin;

create table if not exists public.sesiones_activas (
  user_id uuid primary key references public.perfiles(user_id) on delete cascade,
  sesion_id uuid,                       -- null = sin sesión
  equipo text,                          -- p. ej. "Chrome en Windows"
  iniciada_en timestamptz,
  ultima_actividad timestamptz,
  revocada uuid                         -- sesión que cerró un administrador (ya no puede volver)
);
alter table public.sesiones_activas enable row level security;
revoke all on public.sesiones_activas from anon, authenticated;
grant select on public.sesiones_activas to authenticated;
drop policy if exists sesiones_activas_admin on public.sesiones_activas;
create policy sesiones_activas_admin on public.sesiones_activas for select to authenticated
  using (public.es_admin() or user_id = auth.uid());

-- Minutos sin latido para considerar que una sesión ya se cerró
create or replace function public.sesion_caduca() returns interval
language sql immutable as $$ select interval '3 minutes' $$;

/**
 * Toma o mantiene la sesión del usuario actual. p = {sesion uuid, equipo text}
 * Devuelve {estado: 'ok' | 'ocupada' | 'revocada', equipo, desde}
 */
create or replace function public.tomar_sesion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_ses uuid := nullif(p->>'sesion', '')::uuid;
  r sesiones_activas;
begin
  perform exigir(v_uid is not null, 'Inicia sesión.');
  perform exigir(v_ses is not null, 'Falta el identificador de sesión.');
  perform exigir(exists (select 1 from perfiles where user_id = v_uid and activo), 'Tu usuario está desactivado.');

  insert into sesiones_activas (user_id) values (v_uid) on conflict (user_id) do nothing;
  select * into r from sesiones_activas where user_id = v_uid for update;

  if r.revocada = v_ses then
    return jsonb_build_object('estado', 'revocada');
  end if;

  if r.sesion_id = v_ses then
    update sesiones_activas set ultima_actividad = now(),
      equipo = coalesce(nullif(left(p->>'equipo', 80), ''), equipo)
     where user_id = v_uid;
    return jsonb_build_object('estado', 'ok');
  end if;

  if r.sesion_id is not null and r.ultima_actividad > now() - sesion_caduca() then
    return jsonb_build_object('estado', 'ocupada', 'equipo', r.equipo, 'desde', r.iniciada_en);
  end if;

  update sesiones_activas set sesion_id = v_ses, equipo = nullif(left(p->>'equipo', 80), ''),
    iniciada_en = now(), ultima_actividad = now()
   where user_id = v_uid;
  return jsonb_build_object('estado', 'ok');
end $$;

/** Al salir: libera la sesión si es la de este navegador. p = {sesion} */
create or replace function public.dejar_sesion(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update sesiones_activas set sesion_id = null, ultima_actividad = null
   where user_id = auth.uid() and sesion_id = nullif(p->>'sesion', '')::uuid;
end $$;

/** Un administrador cierra la sesión de otro usuario (p. ej. se quedó abierta en otro equipo). p = {user_id} */
create or replace function public.cerrar_sesion_usuario(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_user uuid := nullif(p->>'user_id', '')::uuid;
begin
  perform exigir(public.es_admin(), 'Solo un administrador puede cerrar la sesión de otro usuario.');
  perform exigir(not exists (select 1 from perfiles where user_id = v_user and propietario)
                 or public.es_propietario(), 'Solo el propietario puede cerrar la sesión del propietario.');
  update sesiones_activas set revocada = sesion_id, sesion_id = null, ultima_actividad = null
   where user_id = v_user and sesion_id is not null;
end $$;

revoke all on function public.tomar_sesion(jsonb), public.dejar_sesion(jsonb), public.cerrar_sesion_usuario(jsonb) from public, anon;
grant execute on function public.tomar_sesion(jsonb), public.dejar_sesion(jsonb), public.cerrar_sesion_usuario(jsonb) to authenticated;

commit;
