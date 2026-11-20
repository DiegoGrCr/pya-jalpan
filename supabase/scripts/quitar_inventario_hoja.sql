-- =============================================================================
-- Quita lo que creó la migración 20261120000048_inventario_hoja.sql (inventario desde hojas de cálculo).
-- Se ejecuta a mano en el SQL Editor de Supabase. Se puede ejecutar más de una vez.
-- Si ya se había sincronizado alguna hoja, esas existencias y sus ajustes en el kardex se quedan
-- (el kardex no se borra); solo se quita la configuración y las funciones.
-- =============================================================================
begin;
drop function if exists public.sincronizar_hoja(jsonb);
drop function if exists public.configurar_hoja_almacen(jsonb);
alter table public.almacenes drop column if exists hoja_resultado;
alter table public.almacenes drop column if exists hoja_sincronizada_en;
alter table public.almacenes drop column if exists hoja_url;
alter table public.almacenes drop column if exists fuente_inventario;
commit;
