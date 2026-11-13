-- =============================================================================
-- 0010 · Datos para imprimir la remisión (nota de venta)
-- Encabezado del emisor, logotipo, condiciones generales y datos de cada sucursal.
-- Los valores reales los captura el administrador en Configuración › Empresa y documentos.
-- =============================================================================

alter table public.empresa
  add column nombre_emisor      text,      -- como aparece en el encabezado (persona física o moral)
  add column telefono           text,
  add column logo               text       -- imagen como data URL (PNG/JPEG), máx. ~700 KB
    check (logo is null or (logo ~ '^data:image/(png|jpeg);base64,' and length(logo) <= 1000000)),
  add column condiciones_venta  text,      -- texto de "Condiciones generales" al pie de la remisión
  add column remision_titulo    text not null default 'Remisión',
  add column remision_firma     boolean not null default true,   -- línea de firma del cliente
  -- Precios con IVA incluido: false = la remisión muestra el total sin desglosar (IVA 0 %),
  -- como se acostumbra en las notas; true = desglosa subtotal + IVA.
  add column remision_desglosa_iva boolean not null default false;

alter table public.sucursales
  add column telefono          text,
  add column lugar_expedicion  text;      -- p. ej. "Municipio, Estado"

create or replace function public.actualizar_sucursal(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_antes sucursales%rowtype;
begin
  perform exigir(tiene_permiso('administrar'), 'No tienes permiso para modificar sucursales');
  select * into v_antes from sucursales where id = (p->>'id')::uuid for update;
  perform exigir(v_antes.id is not null, 'Sucursal no encontrada');
  update sucursales set
    nombre           = coalesce(nullif(trim(p->>'nombre'),''), nombre),
    cp_expedicion    = coalesce(nullif(trim(p->>'cp_expedicion'),''), cp_expedicion),
    direccion        = case when p ? 'direccion' then nullif(trim(p->>'direccion'),'') else direccion end,
    telefono         = case when p ? 'telefono' then nullif(trim(p->>'telefono'),'') else telefono end,
    lugar_expedicion = case when p ? 'lugar_expedicion' then nullif(trim(p->>'lugar_expedicion'),'') else lugar_expedicion end,
    activa           = coalesce((p->>'activa')::boolean, activa)
  where id = v_antes.id;
  perform registrar_bitacora('actualizar', 'sucursales', v_antes.id::text, to_jsonb(v_antes), p);
end $$;

revoke execute on function public.actualizar_sucursal(jsonb) from public, anon;
grant execute on function public.actualizar_sucursal(jsonb) to authenticated;
