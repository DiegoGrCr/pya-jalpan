-- =============================================================================
-- 0023 · Espacio privado "notas" (Supabase Storage) para compartir el PDF de una venta
-- por WhatsApp con un enlace firmado que caduca. Solo usuarios activos pueden subir/leer.
-- Si el esquema storage no existe (pruebas locales), no hace nada. Se puede ejecutar más de una vez.
-- =============================================================================
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'Sin Supabase Storage: se omite el espacio "notas"';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('notas', 'notas', false, 5242880, array['application/pdf'])
  on conflict (id) do nothing;

  execute 'drop policy if exists notas_subir on storage.objects';
  execute 'drop policy if exists notas_leer on storage.objects';
  execute 'drop policy if exists notas_actualizar on storage.objects';
  execute $p$create policy notas_subir on storage.objects for insert to authenticated
    with check (bucket_id = 'notas' and exists (select 1 from public.perfiles where user_id = auth.uid() and activo))$p$;
  execute $p$create policy notas_leer on storage.objects for select to authenticated
    using (bucket_id = 'notas' and exists (select 1 from public.perfiles where user_id = auth.uid() and activo))$p$;
  execute $p$create policy notas_actualizar on storage.objects for update to authenticated
    using (bucket_id = 'notas' and exists (select 1 from public.perfiles where user_id = auth.uid() and activo))$p$;
end $$;
