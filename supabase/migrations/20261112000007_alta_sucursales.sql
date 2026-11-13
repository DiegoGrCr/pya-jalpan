-- =====================================================================
-- 0007 · Alta y edición de sucursales desde el sistema
-- crear_sucursal(): en una transacción crea la sucursal, su almacén, su caja
-- y todas sus series de folios. Requiere el permiso 'administrar'.
-- =====================================================================

create or replace function public.crear_sucursal(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_suc uuid; v_alm uuid; v_codigo text := upper(trim(p->>'codigo'));
  v_nombre text := trim(p->>'nombre');
begin
  perform exigir(tiene_permiso('administrar'), 'No tienes permiso para crear sucursales');
  perform exigir(v_codigo ~ '^[A-Z0-9]{1,4}$', 'El código debe tener de 1 a 4 letras o números (se usa como prefijo de los folios)');
  perform exigir(length(coalesce(v_nombre,'')) > 0, 'El nombre es obligatorio');
  perform exigir(not exists (select 1 from sucursales where codigo = v_codigo), 'Ya existe una sucursal con el código ' || v_codigo);
  perform exigir(not exists (select 1 from series where prefijo like v_codigo || '_'),
                 'El código ' || v_codigo || ' choca con prefijos de series existentes');

  insert into sucursales (codigo, nombre, cp_expedicion, direccion)
  values (v_codigo, v_nombre, nullif(trim(p->>'cp_expedicion'),''), nullif(trim(p->>'direccion'),''))
  returning id into v_suc;

  insert into almacenes (sucursal_id, nombre)
  values (v_suc, coalesce(nullif(trim(p->>'almacen'),''), 'ALMACÉN ' || v_codigo))
  returning id into v_alm;

  insert into cajas (sucursal_id, almacen_id, nombre) values (v_suc, v_alm, 'CAJA 1');

  insert into series (sucursal_id, tipo_documento, prefijo)
  select v_suc, t.tipo, v_codigo || t.letra
    from (values ('venta','V'),('cotizacion','C'),('apartado','P'),('abono','B'),('entrega','E'),
                 ('entrada','N'),('traspaso','T'),('ajuste','A'),('conteo','K'),('corte','X'),
                 ('factura','F'),('complemento_pago','R'),('nota_credito','D'),('factura_global','G')) as t(tipo, letra);

  -- Los administradores operan en todas las sucursales
  insert into usuario_sucursales (user_id, sucursal_id)
  select user_id, v_suc from perfiles where rol = 'administrador' and activo
  on conflict do nothing;

  perform registrar_bitacora('crear', 'sucursales', v_suc::text, null, p);
  return jsonb_build_object('sucursal_id', v_suc, 'almacen_id', v_alm, 'codigo', v_codigo);
end $$;

create or replace function public.actualizar_sucursal(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_antes sucursales%rowtype;
begin
  perform exigir(tiene_permiso('administrar'), 'No tienes permiso para modificar sucursales');
  select * into v_antes from sucursales where id = (p->>'id')::uuid for update;
  perform exigir(v_antes.id is not null, 'Sucursal no encontrada');
  update sucursales set
    nombre        = coalesce(nullif(trim(p->>'nombre'),''), nombre),
    cp_expedicion = coalesce(nullif(trim(p->>'cp_expedicion'),''), cp_expedicion),
    direccion     = coalesce(nullif(trim(p->>'direccion'),''), direccion),
    activa        = coalesce((p->>'activa')::boolean, activa)
  where id = v_antes.id;
  perform registrar_bitacora('actualizar', 'sucursales', v_antes.id::text, to_jsonb(v_antes), p);
end $$;

-- Agregar un almacén adicional a una sucursal
create or replace function public.crear_almacen(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform exigir(tiene_permiso('administrar'), 'No tienes permiso para crear almacenes');
  perform exigir(length(trim(coalesce(p->>'nombre',''))) > 0, 'El nombre es obligatorio');
  insert into almacenes (sucursal_id, nombre, multisucursal)
  values ((p->>'sucursal_id')::uuid, trim(p->>'nombre'), coalesce((p->>'multisucursal')::boolean, false))
  returning id into v_id;
  perform registrar_bitacora('crear', 'almacenes', v_id::text, null, p);
  return v_id;
end $$;

revoke execute on function public.crear_sucursal(jsonb), public.actualizar_sucursal(jsonb), public.crear_almacen(jsonb)
  from public, anon;
grant execute on function public.crear_sucursal(jsonb), public.actualizar_sucursal(jsonb), public.crear_almacen(jsonb)
  to authenticated;
