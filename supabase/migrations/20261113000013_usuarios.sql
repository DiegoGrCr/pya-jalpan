-- =============================================================================
-- 0013 · Usuarios con nombre de usuario (p. ej. uno por sucursal)
-- Los usuarios se crean desde Configuración › Usuarios (ruta de servidor con la
-- clave secreta). Internamente Supabase Auth usa el correo <usuario>@usuarios.local.
-- =============================================================================

alter table public.perfiles
  add column if not exists usuario text unique
  check (usuario ~ '^[a-z0-9][a-z0-9._-]{2,29}$');

comment on column public.perfiles.usuario is
  'Nombre de usuario para iniciar sesión (minúsculas, números, punto, guion). Nulo si entra con correo.';

-- -----------------------------------------------------------------------------
-- guardar_usuario: perfil, rol, sucursales y estado. Se llama con la sesión del
-- administrador (así la bitácora registra quién hizo el cambio). La cuenta de
-- Auth (correo/contraseña/bloqueo) la maneja la ruta del servidor.
-- -----------------------------------------------------------------------------
create or replace function public.guardar_usuario(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p->>'user_id')::uuid;
  v_existe boolean;
begin
  perform exigir(es_admin(), 'Solo un administrador puede administrar usuarios');
  perform exigir(v_id is not null and exists (select 1 from auth.users where id = v_id), 'Usuario no encontrado');
  perform exigir(not (p ? 'rol') or p->>'rol' in ('administrador','gerente','cajero','almacenista','facturacion'), 'Rol no válido');
  perform exigir(v_id <> auth.uid() or ((not p ? 'activo' or (p->>'activo')::boolean)
                                        and (not p ? 'rol' or p->>'rol' = 'administrador')),
                 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  select exists (select 1 from perfiles where user_id = v_id) into v_existe;

  if not v_existe then
    perform exigir(nullif(trim(p->>'nombre'), '') is not null and p ? 'rol', 'Faltan nombre o rol');
    insert into perfiles (user_id, nombre, rol, usuario, activo)
    values (v_id, trim(p->>'nombre'), p->>'rol', nullif(lower(trim(p->>'usuario')), ''), true);
  else
    update perfiles set
      nombre = case when p ? 'nombre' then coalesce(nullif(trim(p->>'nombre'), ''), nombre) else nombre end,
      rol    = coalesce(p->>'rol', rol),
      activo = coalesce((p->>'activo')::boolean, activo)
     where user_id = v_id;
  end if;

  if p ? 'sucursales' then
    perform exigir(not exists (select 1 from jsonb_array_elements_text(p->'sucursales') s
                                where not exists (select 1 from sucursales where id = s::uuid)), 'Sucursal no válida');
    delete from usuario_sucursales where user_id = v_id
      and sucursal_id not in (select s::uuid from jsonb_array_elements_text(p->'sucursales') s);
    insert into usuario_sucursales (user_id, sucursal_id)
      select v_id, s::uuid from jsonb_array_elements_text(p->'sucursales') s
      on conflict do nothing;
  end if;
  perform exigir((select rol from perfiles where user_id = v_id) = 'administrador'
                 or exists (select 1 from usuario_sucursales where user_id = v_id), 'Asigna al menos una sucursal');
end $$;

revoke execute on function public.guardar_usuario(jsonb) from public, anon;
grant execute on function public.guardar_usuario(jsonb) to authenticated;
