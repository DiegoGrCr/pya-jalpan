-- =============================================================================
-- 0024 · Cualquier usuario puede cancelar ventas de su sucursal (queda registrado
-- quién canceló, cuándo y el motivo). Se puede ejecutar más de una vez.
-- =============================================================================
insert into public.rol_permisos (rol, permiso) values
  ('cajero', 'cancelar_ventas'), ('almacenista', 'cancelar_ventas'), ('facturacion', 'cancelar_ventas')
on conflict do nothing;
