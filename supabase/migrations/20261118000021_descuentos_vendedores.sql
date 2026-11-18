-- =============================================================================
-- 0021 · Los vendedores (rol cajero) también pueden aplicar descuentos en la venta
-- Se puede ejecutar más de una vez.
-- =============================================================================
insert into public.rol_permisos (rol, permiso) values ('cajero', 'aplicar_descuentos')
on conflict do nothing;
