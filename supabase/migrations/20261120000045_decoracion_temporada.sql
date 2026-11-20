-- =============================================================================
-- 0045 · Decoración de temporada en remisiones y cotizaciones impresas (Navidad, Día de Muertos,
-- Fiestas Patrias, San Valentín, Día de las Madres). Se activa sola por fecha; aquí se puede apagar.
-- Se cambia en Configuración › Empresa y documentos. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.empresa add column if not exists decoracion_temporada boolean not null default true;
