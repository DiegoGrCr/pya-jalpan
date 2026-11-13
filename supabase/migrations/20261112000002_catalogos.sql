-- =====================================================================
-- 0002 · Catálogos: SAT, categorías, marcas, productos, unidades de venta,
-- listas de precios, parámetros por almacén, proveedores y clientes.
-- =====================================================================

-- Catálogos del SAT actualizables sin tocar código (se cargan por importación)
create table public.sat_catalogo (
  catalogo    text not null,          -- 'ClaveProdServ','ClaveUnidad','RegimenFiscal','UsoCFDI','FormaPago',...
  clave       text not null,
  descripcion text not null,
  vigente     boolean not null default true,
  datos       jsonb,                  -- columnas extra del catálogo (p. ej. regímenes permitidos por uso)
  primary key (catalogo, clave)
);

create table public.categorias (
  id       uuid primary key default gen_random_uuid(),
  nombre   text not null,
  padre_id uuid references public.categorias(id),
  unique (padre_id, nombre)
);

create table public.marcas (
  id     uuid primary key default gen_random_uuid(),
  nombre text not null unique
);

create table public.productos (
  id                 uuid primary key default gen_random_uuid(),
  sku                text not null unique,
  codigo_barras      text,
  nombre             text not null,
  descripcion        text,
  categoria_id       uuid references public.categorias(id),
  marca_id           uuid references public.marcas(id),
  tipo               text not null default 'producto' check (tipo in ('producto','servicio')),
  imagen_url         text,
  activo             boolean not null default true,
  unidad_base        text not null,                 -- p. ej. 'M2', 'PZA'
  clave_sat_prodserv text not null default '01010101',
  clave_sat_unidad   text not null,                 -- clave SAT de la unidad base (MTK, H87...)
  iva_tasa           numeric(6,4) not null default 0.16 check (iva_tasa in (0, 0.08, 0.16)),
  iva_exento         boolean not null default false,
  ieps_tasa          numeric(6,4) not null default 0,
  objeto_impuesto    text not null default '02',
  -- true: se vende cualquier fracción; false: solo unidades completas de la unidad elegida
  permite_fraccion   boolean not null default true,
  controla_lote      boolean not null default false,
  costo_metodo       text not null default 'promedio' check (costo_metodo in ('promedio','fijo')),
  costo_promedio     numeric(18,6) not null default 0 check (costo_promedio >= 0),
  ultimo_costo       numeric(18,6) not null default 0 check (ultimo_costo >= 0),
  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);
create unique index productos_codigo_barras on public.productos (codigo_barras) where codigo_barras is not null;
create index productos_nombre_trgm on public.productos using gin (to_tsvector('spanish', nombre));
create index productos_categoria on public.productos (categoria_id);

-- Unidades de venta. La unidad base es una fila más con factor 1 y es_base = true.
create table public.unidades_venta (
  id               uuid primary key default gen_random_uuid(),
  producto_id      uuid not null references public.productos(id) on delete cascade,
  nombre           text not null,                         -- 'CAJA','PIEZA','M2'
  factor           numeric(18,8) not null check (factor > 0), -- unidades base por 1 unidad de venta
  es_base          boolean not null default false,
  codigo_barras    text,
  clave_sat_unidad text not null,                         -- XBX, H87, MTK...
  activa           boolean not null default true,
  orden            smallint not null default 0,
  unique (producto_id, nombre),
  check (not es_base or factor = 1)
);
create unique index unidades_una_base on public.unidades_venta (producto_id) where es_base;
create unique index unidades_codigo_barras on public.unidades_venta (codigo_barras) where codigo_barras is not null;

-- Crea la unidad base automáticamente al dar de alta un producto
create or replace function public.trg_producto_unidad_base()
returns trigger language plpgsql as $$
begin
  insert into unidades_venta (producto_id, nombre, factor, es_base, clave_sat_unidad, orden)
  values (new.id, new.unidad_base, 1, true, new.clave_sat_unidad, 99)
  on conflict (producto_id, nombre) do nothing;
  return new;
end $$;
create trigger producto_unidad_base after insert on public.productos
  for each row execute function public.trg_producto_unidad_base();

create table public.listas_precios (
  id                 uuid primary key default gen_random_uuid(),
  nombre             text not null unique,
  predeterminada     boolean not null default false,
  -- true: el precio capturado ya incluye impuestos (se desglosa al vender). Pendiente P8/P43.
  incluye_impuestos  boolean not null default false
);
create unique index listas_una_predeterminada on public.listas_precios (predeterminada) where predeterminada;

-- Precio propio por unidad de venta y lista
create table public.precios (
  lista_id        uuid not null references public.listas_precios(id) on delete cascade,
  unidad_venta_id uuid not null references public.unidades_venta(id) on delete cascade,
  precio          numeric(14,2) not null check (precio >= 0),
  actualizado_en  timestamptz not null default now(),
  primary key (lista_id, unidad_venta_id)
);

-- Bitácora de cambios de precio
create trigger bitacora_precios after insert or update or delete on public.precios
  for each row execute function public.trg_bitacora();

-- Mínimo, máximo, punto de reorden y ubicación por almacén
create table public.producto_almacen (
  producto_id   uuid not null references public.productos(id) on delete cascade,
  almacen_id    uuid not null references public.almacenes(id),
  minimo        numeric(18,6) not null default 0,
  maximo        numeric(18,6) not null default 0,
  punto_reorden numeric(18,6) not null default 0,
  ubicacion     text,
  primary key (producto_id, almacen_id)
);

create table public.proveedores (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null,
  rfc       text,
  contacto  text,
  telefono  text,
  correo    text,
  dias_credito integer not null default 0,
  activo    boolean not null default true
);

create table public.clientes (
  id                 uuid primary key default gen_random_uuid(),
  codigo             bigserial unique,
  nombre             text not null,              -- nombre comercial o de contacto
  razon_social       text,                       -- exactamente como en la constancia (CFDI 4.0)
  rfc                text,
  regimen_fiscal     text,
  cp_fiscal          text,
  uso_cfdi           text default 'S01',
  correo_facturas    text,
  telefono           text,
  direccion          text,
  sucursal_id        uuid references public.sucursales(id),
  vendedor_id        uuid references public.perfiles(user_id),
  lista_precios_id   uuid references public.listas_precios(id),
  limite_credito     numeric(14,2) not null default 0 check (limite_credito >= 0),
  dias_credito       integer not null default 0 check (dias_credito >= 0),
  bloqueado          boolean not null default false,
  es_publico_general boolean not null default false,
  es_prospecto       boolean not null default false,
  activo             boolean not null default true,
  creado_en          timestamptz not null default now(),
  check (rfc is null or rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$')
);
create unique index clientes_un_publico_general on public.clientes (es_publico_general) where es_publico_general;
create index clientes_rfc on public.clientes (rfc);
create index clientes_nombre on public.clientes using gin (to_tsvector('spanish', nombre));

insert into public.clientes (nombre, razon_social, rfc, regimen_fiscal, cp_fiscal, uso_cfdi, es_publico_general)
values ('Público en general', 'PUBLICO EN GENERAL', 'XAXX010101000', '616', null, 'S01', true);

create trigger bitacora_clientes_credito after update of limite_credito, dias_credito, bloqueado
  on public.clientes for each row execute function public.trg_bitacora();
