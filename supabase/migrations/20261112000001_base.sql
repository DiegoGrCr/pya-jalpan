-- =====================================================================
-- [NOMBRE] · 0001 · Base: empresa, sucursales, almacenes, cajas, series,
-- usuarios, roles, permisos y bitácora.
-- Convenciones:
--   * Cantidades en unidad base: numeric(18,6)  (ver decisión D2 en docs/plan.md)
--   * Factores de conversión:    numeric(18,8)
--   * Dinero:                     numeric(14,2)
--   * Zona horaria de negocio:    America/Mexico_City
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Empresa (una sola razón social; decisión D1, pendiente P1)
-- ---------------------------------------------------------------------
create table public.empresa (
  id            smallint primary key default 1 check (id = 1),
  nombre_sistema text not null default '[NOMBRE]',
  rfc           text,
  razon_social  text,
  regimen_fiscal text,
  zona_horaria  text not null default 'America/Mexico_City',
  moneda        text not null default 'MXN',
  -- Regla configurable de devolución de anticipo al cancelar un apartado (fase 7)
  apartado_regla_devolucion text not null default 'devolver_todo'
    check (apartado_regla_devolucion in ('devolver_todo','retener_porcentaje','saldo_a_favor')),
  apartado_porcentaje_retencion numeric(5,2) not null default 0
);
insert into public.empresa (id) values (1);

-- ---------------------------------------------------------------------
-- Sucursales, almacenes, cajas
-- ---------------------------------------------------------------------
create table public.sucursales (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique,
  nombre        text not null,
  cp_expedicion text,
  direccion     text,
  activa        boolean not null default true,
  creado_en     timestamptz not null default now()
);

create table public.almacenes (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references public.sucursales(id),
  nombre        text not null,
  multisucursal boolean not null default false,
  activo        boolean not null default true,
  creado_en     timestamptz not null default now(),
  unique (sucursal_id, nombre)
);

create table public.cajas (
  id            uuid primary key default gen_random_uuid(),
  sucursal_id   uuid not null references public.sucursales(id),
  almacen_id    uuid not null references public.almacenes(id),
  nombre        text not null,
  activa        boolean not null default true,
  unique (sucursal_id, nombre)
);

-- ---------------------------------------------------------------------
-- Series y folios por sucursal y tipo de documento
-- ---------------------------------------------------------------------
create table public.series (
  id             uuid primary key default gen_random_uuid(),
  sucursal_id    uuid not null references public.sucursales(id),
  tipo_documento text not null check (tipo_documento in (
    'venta','cotizacion','apartado','abono','entrega','entrada','traspaso',
    'ajuste','conteo','corte','factura','complemento_pago','nota_credito','factura_global')),
  prefijo        text not null,
  siguiente      bigint not null default 1 check (siguiente > 0),
  activa         boolean not null default true,
  unique (sucursal_id, tipo_documento, prefijo)
);
-- Solo una serie activa por sucursal y tipo
create unique index series_una_activa
  on public.series (sucursal_id, tipo_documento) where activa;

-- ---------------------------------------------------------------------
-- Usuarios, roles y permisos
-- ---------------------------------------------------------------------
create table public.perfiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null,
  rol        text not null check (rol in ('administrador','gerente','cajero','almacenista','facturacion')),
  activo     boolean not null default true,
  creado_en  timestamptz not null default now()
);

create table public.usuario_sucursales (
  user_id     uuid not null references public.perfiles(user_id) on delete cascade,
  sucursal_id uuid not null references public.sucursales(id),
  primary key (user_id, sucursal_id)
);

create table public.permisos (
  clave       text primary key,
  descripcion text not null
);
insert into public.permisos (clave, descripcion) values
  ('ver_costos',          'Ver costos y utilidad'),
  ('aplicar_descuentos',  'Aplicar descuentos'),
  ('modificar_precios',   'Modificar el precio de una partida'),
  ('cancelar_ventas',     'Cancelar ventas'),
  ('ajustar_inventario',  'Ajustar inventario y aplicar conteos'),
  ('otorgar_credito',     'Vender a crédito y exceder límite'),
  ('cancelar_apartados',  'Cancelar apartados'),
  ('timbrar_facturas',    'Timbrar facturas'),
  ('cancelar_facturas',   'Cancelar facturas'),
  ('traspasar',           'Enviar y recibir traspasos'),
  ('recibir_mercancia',   'Registrar entradas de mercancía'),
  ('administrar',         'Administrar catálogos, usuarios y configuración');

create table public.rol_permisos (
  rol     text not null,
  permiso text not null references public.permisos(clave),
  primary key (rol, permiso)
);
insert into public.rol_permisos (rol, permiso)
select 'administrador', clave from public.permisos;
insert into public.rol_permisos (rol, permiso) values
  ('gerente','ver_costos'),('gerente','aplicar_descuentos'),('gerente','modificar_precios'),
  ('gerente','cancelar_ventas'),('gerente','ajustar_inventario'),('gerente','otorgar_credito'),
  ('gerente','cancelar_apartados'),('gerente','traspasar'),('gerente','recibir_mercancia'),
  ('almacenista','ajustar_inventario'),('almacenista','traspasar'),('almacenista','recibir_mercancia'),
  ('facturacion','timbrar_facturas'),('facturacion','cancelar_facturas');

-- Excepciones por usuario: conceder o revocar un permiso al margen de su rol
create table public.usuario_permisos (
  user_id   uuid not null references public.perfiles(user_id) on delete cascade,
  permiso   text not null references public.permisos(clave),
  concedido boolean not null,
  primary key (user_id, permiso)
);

-- ---------------------------------------------------------------------
-- Funciones de autorización (usadas por RLS y por las RPC)
-- ---------------------------------------------------------------------
create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from perfiles where user_id = auth.uid() and activo and rol = 'administrador');
$$;

create or replace function public.tiene_permiso(p_permiso text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(
    (select up.concedido from usuario_permisos up
      where up.user_id = auth.uid() and up.permiso = p_permiso),
    exists (select 1 from perfiles pf join rol_permisos rp on rp.rol = pf.rol
             where pf.user_id = auth.uid() and pf.activo and rp.permiso = p_permiso)
  );
$$;

-- ¿El usuario puede OPERAR (vender, cotizar, ajustar, traspasar) en la sucursal?
create or replace function public.opera_sucursal(p_sucursal uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.es_admin() or exists (
    select 1 from usuario_sucursales us join perfiles pf on pf.user_id = us.user_id
     where us.user_id = auth.uid() and pf.activo and us.sucursal_id = p_sucursal);
$$;

-- ¿Puede operar el almacén? (su sucursal, o almacén multisucursal y opera alguna)
create or replace function public.opera_almacen(p_almacen uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from almacenes a
     where a.id = p_almacen and a.activo
       and (public.opera_sucursal(a.sucursal_id)
            or (a.multisucursal and exists (
                  select 1 from usuario_sucursales us where us.user_id = auth.uid()))));
$$;

create or replace function public.exigir(p_condicion boolean, p_mensaje text)
returns void language plpgsql as $$
begin
  if not coalesce(p_condicion, false) then
    raise exception using errcode = 'P0001', message = p_mensaje;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Folio consecutivo: bloquea la fila de la serie (sin huecos por rollback)
-- ---------------------------------------------------------------------
create or replace function public.siguiente_folio(p_sucursal uuid, p_tipo text, out serie text, out folio bigint)
language plpgsql security definer set search_path = public as $$
begin
  update series s set siguiente = s.siguiente + 1
   where s.sucursal_id = p_sucursal and s.tipo_documento = p_tipo and s.activa
  returning s.prefijo, s.siguiente - 1 into serie, folio;
  if folio is null then
    raise exception 'No hay serie activa de % para la sucursal', p_tipo;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Bitácora de acciones sensibles
-- ---------------------------------------------------------------------
create table public.bitacora (
  id          bigserial primary key,
  fecha       timestamptz not null default now(),
  user_id     uuid,
  accion      text not null,
  entidad     text not null,
  entidad_id  text,
  antes       jsonb,
  despues     jsonb
);
create index bitacora_entidad on public.bitacora (entidad, entidad_id);
create index bitacora_fecha on public.bitacora (fecha desc);

create or replace function public.registrar_bitacora(p_accion text, p_entidad text, p_id text, p_antes jsonb, p_despues jsonb)
returns void language sql security definer set search_path = public as $$
  insert into bitacora (user_id, accion, entidad, entidad_id, antes, despues)
  values (auth.uid(), p_accion, p_entidad, p_id, p_antes, p_despues);
$$;

-- Bitácora automática de cambios en permisos y roles
create or replace function public.trg_bitacora()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform registrar_bitacora(lower(tg_op), tg_table_name,
    coalesce((case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'user_id',
             (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end)->>'id'),
    case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end,
    case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create trigger bitacora_perfiles after insert or update or delete on public.perfiles
  for each row execute function public.trg_bitacora();
create trigger bitacora_usuario_permisos after insert or update or delete on public.usuario_permisos
  for each row execute function public.trg_bitacora();
create trigger bitacora_usuario_sucursales after insert or update or delete on public.usuario_sucursales
  for each row execute function public.trg_bitacora();
