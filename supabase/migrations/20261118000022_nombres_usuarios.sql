-- =============================================================================
-- 0022 · Nombres de usuarios para mostrar "Capturó" en ventas y listados
-- perfiles solo se lee completo con permiso de administrar; esto devuelve únicamente
-- el nombre (sin rol, correo ni sucursales). Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.nombres_usuarios(p_ids uuid[])
returns table (user_id uuid, nombre text)
language sql stable security definer set search_path = public as $$
  select p.user_id, p.nombre from perfiles p
   where p.user_id = any(p_ids)
     and exists (select 1 from perfiles yo where yo.user_id = auth.uid() and yo.activo);
$$;
revoke execute on function public.nombres_usuarios(uuid[]) from public, anon;
grant execute on function public.nombres_usuarios(uuid[]) to authenticated;
