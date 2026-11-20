-- =============================================================================
-- 0046 · Foto del producto (para identificarlo en inventario y al vender; no se imprime).
--   · Carpeta "productos" en Supabase Storage: cualquiera con el enlace puede ver la foto; solo
--     usuarios con permiso de editar productos pueden subir, reemplazar o borrar.
--   · foto_producto({producto_id, imagen_url | null}): pone o quita la foto del producto.
-- Se puede ejecutar más de una vez.
-- =============================================================================

-- Storage (solo existe en Supabase; en otras bases se omite)
do $$
begin
  if to_regclass('storage.buckets') is null then return; end if;
  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('productos', 'productos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists productos_fotos_subir on storage.objects';
  execute 'drop policy if exists productos_fotos_cambiar on storage.objects';
  execute 'drop policy if exists productos_fotos_borrar on storage.objects';
  execute $p$create policy productos_fotos_subir on storage.objects for insert to authenticated
           with check (bucket_id = 'productos' and public.tiene_permiso('editar_productos'))$p$;
  execute $p$create policy productos_fotos_cambiar on storage.objects for update to authenticated
           using (bucket_id = 'productos' and public.tiene_permiso('editar_productos'))$p$;
  execute $p$create policy productos_fotos_borrar on storage.objects for delete to authenticated
           using (bucket_id = 'productos' and public.tiene_permiso('editar_productos'))$p$;
end $$;

create or replace function public.foto_producto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := (p->>'producto_id')::uuid; v_url text := nullif(trim(p->>'imagen_url'), ''); v_ant text;
begin
  perform exigir(tiene_permiso('editar_productos'), 'No tienes permiso para editar productos');
  select imagen_url into v_ant from productos where id = v_id for update;
  perform exigir(found, 'Producto no encontrado');
  perform exigir(v_url is null or v_url ~ '^https?://', 'Enlace de imagen no válido');
  update productos set imagen_url = v_url, actualizado_en = now() where id = v_id;
  perform registrar_bitacora('foto', 'productos', v_id::text, jsonb_build_object('imagen_url', v_ant), jsonb_build_object('imagen_url', v_url));
  return jsonb_build_object('producto_id', v_id, 'imagen_url', v_url, 'anterior', v_ant);
end $$;
revoke execute on function public.foto_producto(jsonb) from public, anon;
grant execute on function public.foto_producto(jsonb) to authenticated;
