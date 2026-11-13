-- =============================================================================
-- 0014 · Propietario de la cuenta
-- Solo el propietario (el primer administrador, dado de alta con el script inicial)
-- puede crear sucursales y almacenes, activarlas/desactivarlas y administrar a
-- otros administradores. Los demás administradores conservan el resto de permisos.
-- =============================================================================

alter table public.perfiles add column if not exists propietario boolean not null default false;
create unique index if not exists perfiles_un_propietario on public.perfiles (propietario) where propietario;

-- El propietario es el administrador más antiguo
update public.perfiles set propietario = true
 where user_id = (select user_id from public.perfiles where rol = 'administrador' order by creado_en, user_id limit 1)
   and not exists (select 1 from public.perfiles where propietario);

create or replace function public.es_propietario()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and activo and propietario and rol = 'administrador');
$$;

-- El propietario no se puede degradar, desactivar ni borrar
create or replace function public.trg_proteger_propietario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if old.propietario then raise exception 'No se puede eliminar al propietario de la cuenta'; end if;
    return old;
  end if;
  if old.propietario and (not new.propietario or not new.activo or new.rol <> 'administrador') then
    raise exception 'El propietario de la cuenta debe seguir activo y como administrador';
  end if;
  if new.propietario and not old.propietario then
    raise exception 'El propietario de la cuenta no se puede cambiar desde el sistema';
  end if;
  return new;
end $$;
drop trigger if exists proteger_propietario on public.perfiles;
create trigger proteger_propietario before update or delete on public.perfiles
  for each row execute function public.trg_proteger_propietario();

create or replace function public.crear_sucursal(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_suc uuid; v_alm uuid; v_codigo text := upper(trim(p->>'codigo'));
  v_nombre text := trim(p->>'nombre');
begin
  perform exigir(es_propietario(), 'Solo el propietario de la cuenta puede crear sucursales');
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

create or replace function public.crear_almacen(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  perform exigir(es_propietario(), 'Solo el propietario de la cuenta puede crear almacenes');
  perform exigir(length(trim(coalesce(p->>'nombre',''))) > 0, 'El nombre es obligatorio');
  insert into almacenes (sucursal_id, nombre, multisucursal)
  values ((p->>'sucursal_id')::uuid, trim(p->>'nombre'), coalesce((p->>'multisucursal')::boolean, false))
  returning id into v_id;
  perform registrar_bitacora('crear', 'almacenes', v_id::text, null, p);
  return v_id;
end $$;

create or replace function public.actualizar_sucursal(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare v_antes sucursales%rowtype;
begin
  perform exigir(tiene_permiso('administrar'), 'No tienes permiso para modificar sucursales');
  perform exigir(not p ? 'activa' or es_propietario(), 'Solo el propietario de la cuenta puede activar o desactivar sucursales');
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

create or replace function public.guardar_usuario(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := (p->>'user_id')::uuid;
  v_existe boolean;
begin
  perform exigir(es_admin(), 'Solo un administrador puede administrar usuarios');
  perform exigir(v_id is not null and exists (select 1 from auth.users where id = v_id), 'Usuario no encontrado');
  -- Administradores (y el propietario) solo los administra el propietario
  perform exigir(es_propietario() or (p->>'rol' is distinct from 'administrador'
                   and not exists (select 1 from perfiles where user_id = v_id and (rol = 'administrador' or propietario))),
                 'Solo el propietario de la cuenta puede crear o modificar administradores');
  perform exigir(not (p ? 'rol') or p->>'rol' in ('administrador','gerente','cajero','almacenista','facturacion'), 'Rol no válido');
  perform exigir(v_id <> auth.uid() or ((not p ? 'activo' or (p->>'activo')::boolean)
                                        and (not p ? 'rol' or p->>'rol' = 'administrador')),
                 'No puedes desactivarte ni quitarte el rol de administrador a ti mismo');
  select exists (select 1 from perfiles where user_id = v_id) into v_existe;

  if not v_existe then
    perform exigir(nullif(trim(p->>'nombre'), '') is not null and p ? 'rol', 'Faltan nombre o rol');
    insert into perfiles (user_id, nombre, rol, usuario, activo)
    values (v_id, trim(p->>'nombre'), p->>'rol', nullif(lower(trim(p->>'usuario')), ''), true);
  else
    update perfiles set
      nombre = case when p ? 'nombre' then coalesce(nullif(trim(p->>'nombre'), ''), nombre) else nombre end,
      rol    = coalesce(p->>'rol', rol),
      activo = coalesce((p->>'activo')::boolean, activo)
     where user_id = v_id;
  end if;

  if p ? 'sucursales' then
    perform exigir(not exists (select 1 from jsonb_array_elements_text(p->'sucursales') s
                                where not exists (select 1 from sucursales where id = s::uuid)), 'Sucursal no válida');
    delete from usuario_sucursales where user_id = v_id
      and sucursal_id not in (select s::uuid from jsonb_array_elements_text(p->'sucursales') s);
    insert into usuario_sucursales (user_id, sucursal_id)
      select v_id, s::uuid from jsonb_array_elements_text(p->'sucursales') s
      on conflict do nothing;
  end if;
  perform exigir((select rol from perfiles where user_id = v_id) = 'administrador'
                 or exists (select 1 from usuario_sucursales where user_id = v_id), 'Asigna al menos una sucursal');
end $$;

revoke execute on function public.es_propietario(), public.crear_sucursal(jsonb), public.crear_almacen(jsonb),
  public.actualizar_sucursal(jsonb), public.guardar_usuario(jsonb) from public, anon;
grant execute on function public.es_propietario(), public.crear_sucursal(jsonb), public.crear_almacen(jsonb),
  public.actualizar_sucursal(jsonb), public.guardar_usuario(jsonb) to authenticated;
