-- =============================================================================
-- 0036 · Color de interfaz por usuario (p. ej. una sucursal en morado)
-- null = color normal del sistema. Solo un administrador lo cambia. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.perfiles add column if not exists tema text check (tema in ('verde', 'morado', 'terracota', 'grafito'));

-- {user_id, tema}
create or replace function public.cambiar_tema_usuario(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform exigir(es_admin(), 'Solo un administrador puede cambiar el color de un usuario');
  update perfiles set tema = nullif(p->>'tema', '') where user_id = (p->>'user_id')::uuid;
  perform exigir(found, 'Usuario no encontrado');
  perform registrar_bitacora('tema', 'perfiles', p->>'user_id', null, p);
end $$;
revoke execute on function public.cambiar_tema_usuario(jsonb) from public, anon;
grant execute on function public.cambiar_tema_usuario(jsonb) to authenticated;
