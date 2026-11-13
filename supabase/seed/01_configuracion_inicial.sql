-- =====================================================================
-- Configuración inicial (ejecutar UNA vez en el SQL Editor de Supabase,
-- después de las migraciones 0001–0007).
--
-- Crea la sucursal PRINCIPAL (con almacén, caja y series) y da de alta al
-- administrador. Las demás sucursales se crean desde el sistema:
-- Configuración > Sucursales.
--
-- ANTES DE EJECUTAR: cambia admin@ejemplo.com por el correo del administrador
-- (el usuario debe existir en Authentication). También puedes cambiar el nombre, el CP de expedición y el código.
-- El código se usa como prefijo de folios (PV = ventas, PC = cotizaciones, PF = facturas...)
-- y no debe coincidir con las series de Bind (AR, BSA, MR, RL, AF, MF, SF, AC).
-- =====================================================================
begin;

-- Administrador (usuario creado en Authentication)
insert into perfiles (user_id, nombre, rol)
select id, 'Administrador', 'administrador' from auth.users where email = 'admin@ejemplo.com'  -- ← correo del administrador
on conflict (user_id) do nothing;

do $$ begin
  if not exists (select 1 from perfiles where rol = 'administrador') then
    raise exception 'No se encontró el usuario administrador en Authentication: revisa el correo en este script.';
  end if;
end $$;

-- Lista de precios predeterminada: los precios YA incluyen IVA
insert into listas_precios (nombre, predeterminada, incluye_impuestos)
select 'GENERAL', true, true where not exists (select 1 from listas_precios where predeterminada);

-- Sucursal principal: se usa la misma función que el sistema, a nombre del administrador
select set_config('request.jwt.claims',
  json_build_object('sub', (select user_id from perfiles where rol = 'administrador' limit 1))::text, true);

select crear_sucursal(jsonb_build_object(
  'codigo', 'P',
  'nombre', 'PRINCIPAL',
  'cp_expedicion', '00000',     -- cambia por el CP de expedición real
  'almacen', 'ALMACÉN PRINCIPAL'));

commit;
