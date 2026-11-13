-- =====================================================================
-- 0008 · Reglas de negocio confirmadas por el usuario (12-nov-2026)
--   * Los precios de lista YA incluyen IVA (la nota muestra el total; el IVA se desglosa al facturar).
--   * Formas de pago: efectivo, transferencia, tarjeta de débito y de crédito (con referencia opcional).
--   * Corte de caja semanal (sábado) por sucursal/caja.
--   * Apartados: anticipo mínimo 30 %.
--   * Usuarios por tienda; la tienda principal con más accesos; rol de contador a futuro.
-- =====================================================================

alter table public.listas_precios alter column incluye_impuestos set default true;
update public.listas_precios set incluye_impuestos = true;

alter table public.empresa
  add column if not exists apartado_anticipo_minimo numeric(5,2) not null default 30
    check (apartado_anticipo_minimo between 0 and 100),
  add column if not exists corte_periodicidad text not null default 'semanal'
    check (corte_periodicidad in ('diario','semanal')),
  add column if not exists corte_dia_semana smallint not null default 6   -- 0 = domingo … 6 = sábado
    check (corte_dia_semana between 0 and 6);

-- Rol de contador (consulta y facturación; sin ventas ni inventario)
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
  check (rol in ('administrador','gerente','cajero','almacenista','facturacion','contador'));
insert into public.rol_permisos (rol, permiso) values
  ('contador','ver_costos'),('contador','timbrar_facturas'),('contador','cancelar_facturas')
on conflict do nothing;
