-- =====================================================================
-- 0004 · Cotizaciones, ventas, pagos, entregas parciales.
-- confirmar_venta(): UNA transacción, idempotente, bloquea existencias,
-- permite existencia negativa con aviso y registra costo pendiente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Cálculo de importes de una partida (compartido por cotización y venta)
-- ---------------------------------------------------------------------
create or replace function public.calcular_partida(
  p_cantidad numeric, p_precio numeric, p_descuento numeric,
  p_iva numeric, p_ieps numeric, p_incluye_impuestos boolean,
  out subtotal numeric, out ieps numeric, out iva numeric, out total numeric)
language plpgsql immutable as $$
declare v_bruto numeric(14,2);
begin
  v_bruto := round(p_cantidad * p_precio, 2) - coalesce(p_descuento, 0);
  if v_bruto < 0 then raise exception 'El descuento no puede ser mayor al importe'; end if;
  if p_incluye_impuestos then
    total    := v_bruto;
    subtotal := round(v_bruto / ((1 + p_ieps) * (1 + p_iva)), 2);
    ieps     := round(subtotal * p_ieps, 2);
    iva      := total - subtotal - ieps;
  else
    subtotal := v_bruto;
    ieps     := round(subtotal * p_ieps, 2);
    iva      := round((subtotal + ieps) * p_iva, 2);
    total    := subtotal + ieps + iva;
  end if;
end $$;

-- Calculadora: unidades de venta necesarias para cubrir una cantidad en unidad base
-- (p. ej. 10 m² con caja de 1.44 -> 7 cajas = 10.08 m²)
create or replace function public.calcular_unidades(p_unidad_venta uuid, p_cantidad_base numeric,
  out unidades numeric, out cantidad_base_real numeric)
language plpgsql stable set search_path = public as $$
declare u unidades_venta%rowtype; v_frac boolean;
begin
  select * into u from unidades_venta where id = p_unidad_venta;
  select permite_fraccion into v_frac from productos where id = u.producto_id;
  if v_frac and u.es_base then
    unidades := p_cantidad_base;
  else
    unidades := ceil(p_cantidad_base / u.factor);
  end if;
  cantidad_base_real := round(unidades * u.factor, 6);
end $$;

-- Lista de precios efectiva: la indicada, la del cliente o la predeterminada
create or replace function public.lista_efectiva(p_lista uuid, p_cliente uuid)
returns uuid language sql stable set search_path = public as $$
  select coalesce(p_lista,
                  (select lista_precios_id from clientes where id = p_cliente),
                  (select id from listas_precios where predeterminada));
$$;

-- ---------------------------------------------------------------------
-- Cotizaciones
-- ---------------------------------------------------------------------
create table public.cotizaciones (
  id             uuid primary key default gen_random_uuid(),
  sucursal_id    uuid not null references public.sucursales(id),
  almacen_id     uuid not null references public.almacenes(id),
  serie          text not null,
  folio          bigint not null,
  cliente_id     uuid references public.clientes(id),
  prospecto      text,                                 -- nombre libre si no es cliente
  vendedor_id    uuid,
  lista_id       uuid not null references public.listas_precios(id),
  fecha          timestamptz not null default now(),
  vigencia       date not null,
  estado         text not null default 'borrador' check (estado in ('borrador','enviada','convertida','cancelada')),
  subtotal       numeric(14,2) not null default 0,
  descuento      numeric(14,2) not null default 0,
  ieps           numeric(14,2) not null default 0,
  iva            numeric(14,2) not null default 0,
  total          numeric(14,2) not null default 0,
  comentarios    text,
  venta_id       uuid unique,                          -- FK abajo; una sola conversión
  duplicada_de   uuid references public.cotizaciones(id),
  idempotency_key text unique,
  unique (sucursal_id, serie, folio),
  check (cliente_id is not null or prospecto is not null)
);
create index cotizaciones_sucursal_fecha on public.cotizaciones (sucursal_id, fecha desc);
create index cotizaciones_estado on public.cotizaciones (estado, vigencia);

-- "vencida" se calcula: no se guarda
create or replace view public.v_cotizaciones with (security_invoker = true) as
select c.*,
  case when c.estado in ('borrador','enviada')
        and c.vigencia < (now() at time zone 'America/Mexico_City')::date then 'vencida'
       else c.estado end as estado_actual
from public.cotizaciones c;

create table public.cotizacion_partidas (
  id              uuid primary key default gen_random_uuid(),
  cotizacion_id   uuid not null references public.cotizaciones(id) on delete cascade,
  renglon         smallint not null,
  producto_id     uuid not null references public.productos(id),
  unidad_venta_id uuid not null references public.unidades_venta(id),
  unidad_nombre   text not null,
  factor          numeric(18,8) not null,
  cantidad        numeric(18,6) not null check (cantidad > 0),
  cantidad_base   numeric(18,6) not null,
  precio_unitario numeric(14,2) not null,
  descuento       numeric(14,2) not null default 0,
  iva_tasa        numeric(6,4) not null,
  ieps_tasa       numeric(6,4) not null,
  subtotal        numeric(14,2) not null,
  ieps            numeric(14,2) not null,
  iva             numeric(14,2) not null,
  total           numeric(14,2) not null,
  unique (cotizacion_id, renglon)
);

-- p: {sucursal_id, almacen_id, cliente_id|prospecto, lista_id, vigencia, comentarios, estado, idempotency_key,
--     duplicada_de, partidas:[{producto_id, unidad_venta_id, cantidad, precio_unitario, descuento}]}
create or replace function public.guardar_cotizacion(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_serie text; v_folio bigint; v_lista uuid; v_incl boolean; r record; c record; v_ren int := 0;
        v_ex uuid; v_precio_lista numeric;
begin
  select id into v_ex from cotizaciones where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('cotizacion_id', v_ex, 'repetida', true); end if;

  perform exigir(opera_sucursal((p->>'sucursal_id')::uuid), 'No puedes cotizar en esta sucursal');
  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, nullif(p->>'cliente_id','')::uuid);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;
  select s.serie, s.folio into v_serie, v_folio from siguiente_folio((p->>'sucursal_id')::uuid, 'cotizacion') s;

  insert into cotizaciones (sucursal_id, almacen_id, serie, folio, cliente_id, prospecto, vendedor_id, lista_id, vigencia,
                            estado, comentarios, duplicada_de, idempotency_key)
  values ((p->>'sucursal_id')::uuid, (p->>'almacen_id')::uuid, v_serie, v_folio, nullif(p->>'cliente_id','')::uuid,
          nullif(p->>'prospecto',''), auth.uid(), v_lista,
          coalesce((p->>'vigencia')::date, ((now() at time zone 'America/Mexico_City')::date + 15)),
          coalesce(p->>'estado','borrador'), p->>'comentarios', nullif(p->>'duplicada_de','')::uuid, p->>'idempotency_key')
  returning id into v_id;

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce((x->>'descuento')::numeric,0) descuento,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo
             from jsonb_array_elements(p->'partidas') x
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo, 'Producto o unidad inválidos');
    perform exigir(r.cantidad > 0, 'La cantidad debe ser mayor a cero');
    perform exigir(r.permite_fraccion or r.cantidad = trunc(r.cantidad), 'Este producto solo se vende en unidades completas');
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    perform exigir(r.precio = coalesce(v_precio_lista, r.precio) or tiene_permiso('modificar_precios'),
                   'No tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), 'No tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, v_incl);
    insert into cotizacion_partidas (cotizacion_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, round(r.cantidad * r.factor, 6),
      r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total);
  end loop;
  perform exigir(v_ren > 0, 'La cotización no tiene partidas');

  update cotizaciones q set
    subtotal = s.subtotal, descuento = s.descuento, ieps = s.ieps, iva = s.iva, total = s.total
  from (select sum(subtotal) subtotal, sum(descuento) descuento, sum(ieps) ieps, sum(iva) iva, sum(total) total
          from cotizacion_partidas where cotizacion_id = v_id) s
  where q.id = v_id;

  return jsonb_build_object('cotizacion_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

create or replace function public.cambiar_estado_cotizacion(p_cotizacion uuid, p_estado text)
returns void language plpgsql security definer set search_path = public as $$
declare q cotizaciones%rowtype;
begin
  select * into q from cotizaciones where id = p_cotizacion for update;
  perform exigir(q.id is not null, 'Cotización no encontrada');
  perform exigir(opera_sucursal(q.sucursal_id), 'No puedes modificar esta cotización');
  perform exigir(p_estado in ('enviada','cancelada'), 'Estado no permitido');
  perform exigir(q.estado in ('borrador','enviada'), 'La cotización ya está ' || q.estado);
  update cotizaciones set estado = p_estado where id = p_cotizacion;
end $$;

-- Prepara la conversión: devuelve partidas para el POS con avisos de precio y existencia
create or replace function public.preparar_conversion(p_cotizacion uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare q v_cotizaciones%rowtype; v_res jsonb;
begin
  select * into q from v_cotizaciones where id = p_cotizacion;
  perform exigir(q.id is not null, 'Cotización no encontrada');
  perform exigir(opera_sucursal(q.sucursal_id), 'No puedes convertir esta cotización');
  perform exigir(q.estado not in ('convertida','cancelada'), 'La cotización ya está ' || q.estado);

  select jsonb_agg(jsonb_build_object(
      'producto_id', cp.producto_id, 'unidad_venta_id', cp.unidad_venta_id, 'unidad_nombre', cp.unidad_nombre,
      'cantidad', cp.cantidad, 'cantidad_base', cp.cantidad_base,
      'precio_cotizado', cp.precio_unitario, 'precio_actual', pr.precio, 'descuento', cp.descuento,
      'cambio_precio', pr.precio is distinct from cp.precio_unitario,
      'existencia_base', coalesce(e.cantidad, 0) - coalesce(e.apartado, 0),
      'falta_existencia', coalesce(e.cantidad, 0) - coalesce(e.apartado, 0) < cp.cantidad_base)
      order by cp.renglon)
    into v_res
    from cotizacion_partidas cp
    left join precios pr on pr.lista_id = q.lista_id and pr.unidad_venta_id = cp.unidad_venta_id
    left join existencias e on e.producto_id = cp.producto_id and e.almacen_id = q.almacen_id
   where cp.cotizacion_id = q.id;

  return jsonb_build_object('cotizacion_id', q.id, 'vigente', q.estado_actual <> 'vencida',
    'cliente_id', q.cliente_id, 'lista_id', q.lista_id, 'almacen_id', q.almacen_id, 'sucursal_id', q.sucursal_id,
    'partidas', v_res);
end $$;

-- ---------------------------------------------------------------------
-- Ventas
-- ---------------------------------------------------------------------
create table public.ventas (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  almacen_id       uuid not null references public.almacenes(id),
  caja_id          uuid references public.cajas(id),
  serie            text not null,
  folio            bigint not null,
  cliente_id       uuid not null references public.clientes(id),
  vendedor_id      uuid,
  lista_id         uuid not null references public.listas_precios(id),
  fecha            timestamptz not null default now(),
  tipo             text not null check (tipo in ('contado','credito')),
  estado           text not null default 'confirmada' check (estado in ('confirmada','cancelada')),
  subtotal         numeric(14,2) not null,
  descuento        numeric(14,2) not null,
  ieps             numeric(14,2) not null,
  iva              numeric(14,2) not null,
  total            numeric(14,2) not null,
  pagado           numeric(14,2) not null default 0,
  saldo            numeric(14,2) not null default 0 check (saldo >= 0),
  cambio           numeric(14,2) not null default 0,
  vencimiento      date,
  con_faltante     boolean not null default false,     -- alguna partida vendida sin existencia
  cotizacion_id    uuid unique references public.cotizaciones(id),
  factura_uuid     uuid,                               -- fase 9
  comentarios      text,
  cancelada_en     timestamptz,
  cancelada_por    uuid,
  motivo_cancelacion text,
  idempotency_key  text not null unique,
  unique (sucursal_id, serie, folio)
);
create index ventas_sucursal_fecha on public.ventas (sucursal_id, fecha desc);
create index ventas_cliente_saldo on public.ventas (cliente_id) where saldo > 0 and estado = 'confirmada';
alter table public.cotizaciones add constraint cotizaciones_venta_fk foreign key (venta_id) references public.ventas(id);

create table public.venta_partidas (
  id                 uuid primary key default gen_random_uuid(),
  venta_id           uuid not null references public.ventas(id),
  renglon            smallint not null,
  producto_id        uuid not null references public.productos(id),
  unidad_venta_id    uuid not null references public.unidades_venta(id),
  unidad_nombre      text not null,
  factor             numeric(18,8) not null,
  cantidad           numeric(18,6) not null check (cantidad > 0),          -- en unidad vendida
  cantidad_base      numeric(18,6) not null,                                -- en unidad base
  cantidad_entregada numeric(18,6) not null default 0,                      -- en unidad vendida
  precio_unitario    numeric(14,2) not null,
  precio_lista       numeric(14,2),
  descuento          numeric(14,2) not null default 0,
  iva_tasa           numeric(6,4) not null,
  ieps_tasa          numeric(6,4) not null,
  subtotal           numeric(14,2) not null,
  ieps               numeric(14,2) not null,
  iva                numeric(14,2) not null,
  total              numeric(14,2) not null,
  costo_unitario_base numeric(18,6) not null default 0,
  vendida_sin_existencia boolean not null default false,
  faltante_base      numeric(18,6) not null default 0,
  unique (venta_id, renglon),
  check (cantidad_entregada >= 0 and cantidad_entregada <= cantidad)
);
create index venta_partidas_producto on public.venta_partidas (producto_id);
create index venta_partidas_pendientes on public.venta_partidas (venta_id) where cantidad_entregada < cantidad;
alter table public.costo_pendiente add constraint costo_pendiente_partida_fk
  foreign key (venta_partida_id) references public.venta_partidas(id);

create table public.venta_pagos (
  id         uuid primary key default gen_random_uuid(),
  venta_id   uuid not null references public.ventas(id),
  forma      text not null check (forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia')),
  importe    numeric(14,2) not null check (importe > 0),
  referencia text,
  fecha      timestamptz not null default now()
);

-- Partidas vendidas no entregadas, en unidad base, por producto y almacén
create or replace view public.v_pendiente_entrega with (security_invoker = true) as
select v.almacen_id, vp.producto_id,
       sum(round((vp.cantidad - vp.cantidad_entregada) * vp.factor, 6)) as pendiente_base
  from public.venta_partidas vp join public.ventas v on v.id = vp.venta_id
 where v.estado = 'confirmada' and vp.cantidad_entregada < vp.cantidad
 group by v.almacen_id, vp.producto_id;

-- Saldo y saldo vencido del cliente
create or replace function public.saldo_cliente(p_cliente uuid, out saldo numeric, out vencido numeric)
language sql stable security definer set search_path = public as $$
  select coalesce(sum(saldo), 0),
         coalesce(sum(saldo) filter (where vencimiento < (now() at time zone 'America/Mexico_City')::date), 0)
    from ventas where cliente_id = p_cliente and estado = 'confirmada' and saldo > 0;
$$;

-- ---------------------------------------------------------------------
-- confirmar_venta
-- p: {idempotency_key, sucursal_id, almacen_id, caja_id, cliente_id, lista_id, tipo, cotizacion_id, comentarios,
--     partidas:[{producto_id, unidad_venta_id, cantidad, precio_unitario, descuento, entregar_ahora}],
--     pagos:[{forma, importe, referencia}]}
-- ---------------------------------------------------------------------
create or replace function public.confirmar_venta(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p->>'idempotency_key';
  v_ex ventas%rowtype;
  v_al almacenes%rowtype;
  v_suc uuid := (p->>'sucursal_id')::uuid;
  v_cli clientes%rowtype;
  v_lista uuid; v_incl boolean;
  v_tipo text := coalesce(p->>'tipo', 'contado');
  v_cot cotizaciones%rowtype;
  v_id uuid := gen_random_uuid(); v_serie text; v_folio bigint;
  r record; c record; v_ren int := 0; v_cb numeric; v_antes numeric; v_costo numeric; v_falt numeric;
  v_pid uuid; v_precio_lista numeric; v_precio_cot numeric; v_desc_cot numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
  v_pagos numeric := 0; v_no_efectivo numeric := 0; v_cambio numeric := 0; v_saldo numeric := 0;
  v_sc record; v_avisos jsonb := '[]';
begin
  perform exigir(v_key is not null and length(v_key) >= 8, 'Falta la clave de idempotencia');
  -- Serializa reintentos con la misma clave y devuelve la venta ya creada
  perform pg_advisory_xact_lock(hashtextextended('venta:' || v_key, 0));
  select * into v_ex from ventas where idempotency_key = v_key;
  if v_ex.id is not null then
    return jsonb_build_object('venta_id', v_ex.id, 'serie', v_ex.serie, 'folio', v_ex.folio,
                              'total', v_ex.total, 'cambio', v_ex.cambio, 'repetida', true, 'avisos', '[]'::jsonb);
  end if;

  -- Permisos de sucursal y almacén
  perform exigir(opera_sucursal(v_suc), 'No puedes vender en esta sucursal');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and v_al.activo, 'Almacén no válido');
  perform exigir(v_al.sucursal_id = v_suc or v_al.multisucursal, 'El almacén no pertenece a la sucursal');
  perform exigir(opera_almacen(v_al.id), 'No puedes vender desde este almacén');

  -- Cliente (público en general por defecto)
  if nullif(p->>'cliente_id','') is null then
    select * into v_cli from clientes where es_publico_general;
  else
    select * into v_cli from clientes where id = (p->>'cliente_id')::uuid;
  end if;
  perform exigir(v_cli.id is not null and v_cli.activo, 'Cliente no válido');

  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, v_cli.id);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;
  perform exigir(v_lista is not null, 'No hay lista de precios');

  -- Cotización ligada: se bloquea y no se convierte dos veces
  if nullif(p->>'cotizacion_id','') is not null then
    select * into v_cot from cotizaciones where id = (p->>'cotizacion_id')::uuid for update;
    perform exigir(v_cot.id is not null, 'Cotización no encontrada');
    perform exigir(v_cot.estado in ('borrador','enviada'), 'La cotización ya está ' || v_cot.estado);
  end if;

  -- Bloquea en orden estable las existencias involucradas (solo productos inventariables)
  perform bloquear_existencias((
    select coalesce(jsonb_agg(jsonb_build_object('producto_id', pr.id, 'almacen_id', v_al.id)), '[]')
      from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
     where pr.tipo = 'producto'));

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'venta') s;

  insert into ventas (id, sucursal_id, almacen_id, caja_id, serie, folio, cliente_id, vendedor_id, lista_id, tipo,
                      subtotal, descuento, ieps, iva, total, cotizacion_id, comentarios, idempotency_key)
  values (v_id, v_suc, v_al.id, nullif(p->>'caja_id','')::uuid, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, v_tipo,
          0, 0, 0, 0, 0, v_cot.id, p->>'comentarios', v_key);

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce((x->>'descuento')::numeric, 0) descuento,
                  coalesce((x->>'entregar_ahora')::boolean, true) entregar_ahora,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.tipo, pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre
             from jsonb_array_elements(p->'partidas') x
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo, 'Producto o unidad inválidos');
    perform exigir(r.cantidad > 0, 'La cantidad debe ser mayor a cero');
    perform exigir(r.permite_fraccion or r.cantidad = trunc(r.cantidad),
                   r.producto_nombre || ': solo se vende en unidades completas');

    -- Precio: debe ser el de lista, o el cotizado, o tener permiso
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    v_precio_cot := null; v_desc_cot := 0;
    if v_cot.id is not null then
      select precio_unitario, descuento into v_precio_cot, v_desc_cot from cotizacion_partidas
       where cotizacion_id = v_cot.id and unidad_venta_id = r.unidad_id order by renglon limit 1;
    end if;
    perform exigir(r.precio = v_precio_lista or r.precio = v_precio_cot or tiene_permiso('modificar_precios'),
                   r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or r.descuento <= coalesce(v_desc_cot, 0) or tiene_permiso('aplicar_descuentos'),
                   r.producto_nombre || ': no tienes permiso para aplicar descuentos');

    v_ren := v_ren + 1;
    v_cb := round(r.cantidad * r.factor, 6);
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, v_incl);
    v_costo := coalesce(costo_venta(r.producto_id), 0);

    insert into venta_partidas (venta_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, cantidad_entregada, precio_unitario, precio_lista, descuento, iva_tasa, ieps_tasa,
      subtotal, ieps, iva, total, costo_unitario_base)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, v_cb,
      case when r.entregar_ahora then r.cantidad else 0 end, r.precio, v_precio_lista, r.descuento,
      r.iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, v_costo)
    returning id into v_pid;

    -- Inventario: se descuenta AL CONFIRMAR, aunque la entrega sea posterior
    if r.tipo = 'producto' then
      v_antes := mover_inventario(r.producto_id, v_al.id, -v_cb, 'venta', 'venta', v_id, v_costo);
      if v_antes < v_cb then
        v_falt := v_cb - greatest(v_antes, 0);
        update venta_partidas set vendida_sin_existencia = true, faltante_base = v_falt where id = v_pid;
        insert into costo_pendiente (producto_id, almacen_id, venta_partida_id, cantidad_pendiente, costo_usado)
        values (r.producto_id, v_al.id, v_pid, v_falt, v_costo);
        v_avisos := v_avisos || jsonb_build_object('renglon', v_ren, 'producto', r.producto_nombre,
                      'mensaje', 'Vendida sin existencia suficiente', 'faltante_base', v_falt);
      end if;
    end if;

    t_sub := t_sub + c.subtotal; t_desc := t_desc + r.descuento; t_ieps := t_ieps + c.ieps;
    t_iva := t_iva + c.iva; t_tot := t_tot + c.total;
  end loop;
  perform exigir(v_ren > 0, 'La venta no tiene partidas');

  -- Pagos
  for r in select x->>'forma' forma, (x->>'importe')::numeric importe, x->>'referencia' referencia
             from jsonb_array_elements(coalesce(p->'pagos', '[]')) x
  loop
    perform exigir(r.importe > 0, 'Importe de pago inválido');
    insert into venta_pagos (venta_id, forma, importe, referencia) values (v_id, r.forma, r.importe, r.referencia);
    v_pagos := v_pagos + r.importe;
    if r.forma <> 'efectivo' then v_no_efectivo := v_no_efectivo + r.importe; end if;
  end loop;
  perform exigir(v_no_efectivo <= t_tot, 'Los pagos con tarjeta o transferencia exceden el total');

  if v_tipo = 'contado' then
    perform exigir(v_pagos >= t_tot, 'El pago no cubre el total de la venta');
    v_cambio := v_pagos - t_tot;
    v_saldo := 0;
    -- El cambio sale del efectivo: se registra el efectivo neto
    if v_cambio > 0 then
      update venta_pagos set importe = importe - v_cambio
       where id = (select id from venta_pagos where venta_id = v_id and forma = 'efectivo' order by importe desc limit 1);
    end if;
  else
    perform exigir(not v_cli.es_publico_general, 'La venta a crédito requiere un cliente');
    perform exigir(v_pagos <= t_tot, 'El anticipo excede el total');
    v_saldo := t_tot - v_pagos;
    select * into v_sc from saldo_cliente(v_cli.id);
    perform exigir(not v_cli.bloqueado or tiene_permiso('otorgar_credito'), 'El cliente está bloqueado para crédito');
    perform exigir(v_sc.vencido = 0 or tiene_permiso('otorgar_credito'), 'El cliente tiene saldo vencido');
    perform exigir(v_sc.saldo + v_saldo <= v_cli.limite_credito or tiene_permiso('otorgar_credito'),
                   'La venta excede el límite de crédito del cliente');
  end if;

  update ventas set subtotal = t_sub, descuento = t_desc, ieps = t_ieps, iva = t_iva, total = t_tot,
                    pagado = least(v_pagos, t_tot), saldo = v_saldo, cambio = v_cambio,
                    vencimiento = case when v_tipo = 'credito'
                                       then (now() at time zone 'America/Mexico_City')::date + v_cli.dias_credito end,
                    con_faltante = jsonb_array_length(v_avisos) > 0
   where id = v_id;

  if v_cot.id is not null then
    update cotizaciones set estado = 'convertida', venta_id = v_id where id = v_cot.id;
  end if;

  return jsonb_build_object('venta_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', t_tot,
                            'cambio', v_cambio, 'saldo', v_saldo, 'repetida', false, 'avisos', v_avisos);
end $$;

-- ---------------------------------------------------------------------
-- Cancelar venta: movimiento inverso exacto de lo descontado
-- ---------------------------------------------------------------------
create or replace function public.cancelar_venta(p_venta uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare v ventas%rowtype; m record;
begin
  select * into v from ventas where id = p_venta for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes cancelar ventas de esta sucursal');
  perform exigir(tiene_permiso('cancelar_ventas'), 'No tienes permiso para cancelar ventas');
  perform exigir(v.estado = 'confirmada', 'La venta ya está cancelada');
  perform exigir(length(trim(coalesce(p_motivo,''))) > 0, 'El motivo es obligatorio');
  perform exigir(v.factura_uuid is null, 'La venta está facturada: cancela el CFDI o emite nota de crédito primero');

  perform bloquear_existencias((select coalesce(jsonb_agg(jsonb_build_object('producto_id', producto_id, 'almacen_id', almacen_id)), '[]')
                                  from movimientos where documento_tipo = 'venta' and documento_id = v.id));
  for m in select producto_id, almacen_id, cantidad, costo_unitario from movimientos
            where documento_tipo = 'venta' and documento_id = v.id and tipo = 'venta' order by id
  loop
    perform mover_inventario(m.producto_id, m.almacen_id, -m.cantidad, 'cancelacion_venta', 'venta', v.id,
                             m.costo_unitario, p_motivo);
  end loop;

  update costo_pendiente set cantidad_pendiente = 0
   where venta_partida_id in (select id from venta_partidas where venta_id = v.id);
  update ventas set estado = 'cancelada', saldo = 0, cancelada_en = now(), cancelada_por = auth.uid(),
                    motivo_cancelacion = p_motivo
   where id = v.id;
  if v.cotizacion_id is not null then
    -- La cotización queda ligada a una venta cancelada; no se reabre automáticamente
    null;
  end if;
  perform registrar_bitacora('cancelar', 'ventas', v.id::text, to_jsonb(v), jsonb_build_object('motivo', p_motivo));
end $$;

-- ---------------------------------------------------------------------
-- Entregas parciales: no mueven inventario
-- ---------------------------------------------------------------------
create table public.entregas (
  id          uuid primary key default gen_random_uuid(),
  venta_id    uuid not null references public.ventas(id),
  sucursal_id uuid not null references public.sucursales(id),
  serie       text not null,
  folio       bigint not null,
  fecha       timestamptz not null default now(),
  usuario_id  uuid,
  recibio     text,
  idempotency_key text unique,
  unique (sucursal_id, serie, folio)
);
create table public.entrega_partidas (
  id               uuid primary key default gen_random_uuid(),
  entrega_id       uuid not null references public.entregas(id),
  venta_partida_id uuid not null references public.venta_partidas(id),
  cantidad         numeric(18,6) not null check (cantidad > 0)   -- en unidad vendida
);

-- p: {venta_id, recibio, idempotency_key, partidas:[{venta_partida_id, cantidad}]}
create or replace function public.registrar_entrega(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v ventas%rowtype; v_id uuid; v_serie text; v_folio bigint; r record; vp venta_partidas%rowtype; v_ex uuid;
begin
  select id into v_ex from entregas where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('entrega_id', v_ex, 'repetida', true); end if;

  select * into v from ventas where id = (p->>'venta_id')::uuid for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id) or opera_almacen(v.almacen_id), 'No puedes entregar esta venta');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v.sucursal_id, 'entrega') s;
  insert into entregas (venta_id, sucursal_id, serie, folio, usuario_id, recibio, idempotency_key)
  values (v.id, v.sucursal_id, v_serie, v_folio, auth.uid(), p->>'recibio', p->>'idempotency_key')
  returning id into v_id;

  for r in select (x->>'venta_partida_id')::uuid pid, (x->>'cantidad')::numeric cantidad
             from jsonb_array_elements(p->'partidas') x
  loop
    select * into vp from venta_partidas where id = r.pid and venta_id = v.id for update;
    perform exigir(vp.id is not null, 'La partida no pertenece a la venta');
    perform exigir(r.cantidad > 0, 'Cantidad a entregar inválida');
    perform exigir(vp.cantidad_entregada + r.cantidad <= vp.cantidad, 'No se puede entregar más de lo vendido');
    insert into entrega_partidas (entrega_id, venta_partida_id, cantidad) values (v_id, vp.id, r.cantidad);
    update venta_partidas set cantidad_entregada = cantidad_entregada + r.cantidad where id = vp.id;
  end loop;
  return jsonb_build_object('entrega_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;
