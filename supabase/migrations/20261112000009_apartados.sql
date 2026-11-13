-- =====================================================================
-- 0009 · Apartados
-- Reglas confirmadas (12-nov-2026):
--   * Anticipo mínimo: empresa.apartado_anticipo_minimo (30 %).
--   * Sin plazo máximo: solo se AVISA cuando un apartado tiene más de
--     empresa.apartado_dias_aviso días abierto (30 por omisión).
--   * Al cancelar se retiene empresa.apartado_porcentaje_retencion (10 % inicial,
--     pendiente de que el negocio lo defina) y se devuelve el resto.
--   * Mientras está abierto NO descuenta inventario: reserva (existencias.apartado).
--     Al liquidarse se convierte en venta (confirmar_venta) y ahí descuenta.
--   * El precio queda congelado al apartar.
-- =====================================================================

alter table public.empresa add column if not exists apartado_dias_aviso integer not null default 30
  check (apartado_dias_aviso > 0);
update public.empresa set apartado_regla_devolucion = 'retener_porcentaje', apartado_porcentaje_retencion = 10
 where id = 1 and apartado_porcentaje_retencion = 0;

create table public.apartados (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  almacen_id       uuid not null references public.almacenes(id),
  serie            text not null,
  folio            bigint not null,
  cliente_id       uuid not null references public.clientes(id),
  vendedor_id      uuid,
  lista_id         uuid not null references public.listas_precios(id),
  fecha            timestamptz not null default now(),
  estado           text not null default 'abierto' check (estado in ('abierto','liquidado','cancelado')),
  subtotal         numeric(14,2) not null default 0,
  descuento        numeric(14,2) not null default 0,
  ieps             numeric(14,2) not null default 0,
  iva              numeric(14,2) not null default 0,
  total            numeric(14,2) not null default 0,
  abonado          numeric(14,2) not null default 0,
  saldo            numeric(14,2) not null default 0 check (saldo >= 0),
  venta_id         uuid unique references public.ventas(id),
  porcentaje_retencion numeric(5,2),
  retenido         numeric(14,2),
  devuelto         numeric(14,2),
  motivo_cancelacion text,
  cancelado_en     timestamptz,
  cancelado_por    uuid,
  comentarios      text,
  idempotency_key  text not null unique,
  unique (sucursal_id, serie, folio)
);
create index apartados_abiertos on public.apartados (sucursal_id, fecha) where estado = 'abierto';
create index apartados_cliente on public.apartados (cliente_id);

create table public.apartado_partidas (
  id              uuid primary key default gen_random_uuid(),
  apartado_id     uuid not null references public.apartados(id),
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
  unique (apartado_id, renglon)
);

-- Dinero recibido o devuelto en el apartado (entra al corte de caja del día en que se cobró)
create table public.apartado_pagos (
  id              uuid primary key default gen_random_uuid(),
  apartado_id     uuid not null references public.apartados(id),
  tipo            text not null check (tipo in ('anticipo','abono','devolucion')),
  forma           text not null check (forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia')),
  importe         numeric(14,2) not null check (importe > 0),
  referencia      text,
  fecha           timestamptz not null default now(),
  usuario_id      uuid,
  idempotency_key text unique
);
create index apartado_pagos_fecha on public.apartado_pagos (fecha);

-- En ventas: los anticipos ya cobrados se aplican como forma 'anticipo' (no vuelven a contar en caja)
alter table public.venta_pagos drop constraint if exists venta_pagos_forma_check;
alter table public.venta_pagos add constraint venta_pagos_forma_check
  check (forma in ('efectivo','tarjeta_debito','tarjeta_credito','transferencia','anticipo'));
alter table public.ventas add column if not exists apartado_id uuid unique references public.apartados(id);

-- Vista con aviso por antigüedad
create or replace view public.v_apartados with (security_invoker = true) as
select a.*,
  ((now() at time zone 'America/Mexico_City')::date - (a.fecha at time zone 'America/Mexico_City')::date) as dias_abierto,
  (a.estado = 'abierto' and (now() at time zone 'America/Mexico_City')::date
     - (a.fecha at time zone 'America/Mexico_City')::date >= (select apartado_dias_aviso from public.empresa where id = 1)) as requiere_aviso
from public.apartados a;

-- ---------------------------------------------------------------------
-- crear_apartado
-- p: {idempotency_key, sucursal_id, almacen_id, cliente_id, lista_id, comentarios,
--     partidas:[{producto_id, unidad_venta_id, cantidad, precio_unitario, descuento}],
--     pagos:[{forma, importe, referencia}]}   (anticipo)
-- ---------------------------------------------------------------------
create or replace function public.crear_apartado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p->>'idempotency_key'; v_ex apartados%rowtype; v_al almacenes%rowtype;
  v_suc uuid := (p->>'sucursal_id')::uuid; v_cli clientes%rowtype; v_lista uuid; v_incl boolean;
  v_id uuid := gen_random_uuid(); v_serie text; v_folio bigint; r record; c record; v_ren int := 0;
  v_precio_lista numeric; v_ant numeric := 0; v_min numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
begin
  perform exigir(v_key is not null and length(v_key) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('apartado:' || v_key, 0));
  select * into v_ex from apartados where idempotency_key = v_key;
  if v_ex.id is not null then
    return jsonb_build_object('apartado_id', v_ex.id, 'serie', v_ex.serie, 'folio', v_ex.folio, 'repetida', true);
  end if;

  perform exigir(opera_sucursal(v_suc), 'No puedes apartar en esta sucursal');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and (v_al.sucursal_id = v_suc or v_al.multisucursal) and opera_almacen(v_al.id),
                 'Almacén no válido para esta sucursal');
  select * into v_cli from clientes where id = nullif(p->>'cliente_id','')::uuid;
  perform exigir(v_cli.id is not null and v_cli.activo and not v_cli.es_publico_general,
                 'El apartado requiere un cliente registrado (nombre y teléfono)');
  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, v_cli.id);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;

  perform bloquear_existencias((
    select coalesce(jsonb_agg(jsonb_build_object('producto_id', pr.id, 'almacen_id', v_al.id)), '[]')
      from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
     where pr.tipo = 'producto'));

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'apartado') s;
  insert into apartados (id, sucursal_id, almacen_id, serie, folio, cliente_id, vendedor_id, lista_id, comentarios, idempotency_key)
  values (v_id, v_suc, v_al.id, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, p->>'comentarios', v_key);

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad,
                  (x->>'precio_unitario')::numeric precio, coalesce((x->>'descuento')::numeric, 0) descuento,
                  u.id unidad_id, u.nombre unidad_nombre, u.factor, u.producto_id u_producto,
                  pr.tipo, pr.iva_tasa, pr.ieps_tasa, pr.permite_fraccion, pr.activo, pr.nombre producto_nombre
             from jsonb_array_elements(p->'partidas') x
             join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
             join productos pr on pr.id = u.producto_id
  loop
    perform exigir(r.u_producto = r.producto_id and r.activo and r.cantidad > 0, 'Partida inválida');
    perform exigir(r.permite_fraccion or r.cantidad = trunc(r.cantidad), r.producto_nombre || ': solo se vende en unidades completas');
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    perform exigir(r.precio = v_precio_lista or tiene_permiso('modificar_precios'), r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), r.producto_nombre || ': no tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, v_incl);
    insert into apartado_partidas (apartado_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad, cantidad_base,
      precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, round(r.cantidad * r.factor, 6),
      r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total);
    -- Reserva: no descuenta, solo aparta
    if r.tipo = 'producto' then
      update existencias set apartado = apartado + round(r.cantidad * r.factor, 6), actualizado_en = now()
       where producto_id = r.producto_id and almacen_id = v_al.id;
    end if;
    t_sub := t_sub + c.subtotal; t_desc := t_desc + r.descuento; t_ieps := t_ieps + c.ieps; t_iva := t_iva + c.iva; t_tot := t_tot + c.total;
  end loop;
  perform exigir(v_ren > 0, 'El apartado no tiene partidas');

  for r in select x->>'forma' forma, (x->>'importe')::numeric importe, x->>'referencia' referencia
             from jsonb_array_elements(coalesce(p->'pagos','[]')) x
  loop
    perform exigir(r.importe > 0, 'Importe de anticipo inválido');
    insert into apartado_pagos (apartado_id, tipo, forma, importe, referencia, usuario_id)
    values (v_id, 'anticipo', r.forma, r.importe, r.referencia, auth.uid());
    v_ant := v_ant + r.importe;
  end loop;

  select round(t_tot * apartado_anticipo_minimo / 100, 2) into v_min from empresa where id = 1;
  perform exigir(v_ant >= v_min, format('El anticipo mínimo es %s (%s%% del total)', v_min,
                 (select apartado_anticipo_minimo from empresa where id = 1)));
  perform exigir(v_ant < t_tot, 'El anticipo cubre el total: registra una venta en lugar de un apartado');

  update apartados set subtotal = t_sub, descuento = t_desc, ieps = t_ieps, iva = t_iva, total = t_tot,
                       abonado = v_ant, saldo = t_tot - v_ant
   where id = v_id;
  return jsonb_build_object('apartado_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', t_tot,
                            'abonado', v_ant, 'saldo', t_tot - v_ant, 'repetida', false);
end $$;

-- p: {apartado_id, forma, importe, referencia, idempotency_key}
create or replace function public.abonar_apartado(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a apartados%rowtype; v_imp numeric := (p->>'importe')::numeric; v_ex uuid;
begin
  select id into v_ex from apartado_pagos where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('pago_id', v_ex, 'repetida', true); end if;
  select * into a from apartados where id = (p->>'apartado_id')::uuid for update;
  perform exigir(a.id is not null, 'Apartado no encontrado');
  perform exigir(opera_sucursal(a.sucursal_id), 'No puedes abonar a apartados de esta sucursal');
  perform exigir(a.estado = 'abierto', 'El apartado ya está ' || a.estado);
  perform exigir(v_imp > 0 and v_imp <= a.saldo, format('El abono debe ser mayor a 0 y no mayor al saldo (%s)', a.saldo));
  insert into apartado_pagos (apartado_id, tipo, forma, importe, referencia, usuario_id, idempotency_key)
  values (a.id, 'abono', p->>'forma', v_imp, p->>'referencia', auth.uid(), p->>'idempotency_key')
  returning id into v_ex;
  update apartados set abonado = abonado + v_imp, saldo = saldo - v_imp where id = a.id;
  return jsonb_build_object('pago_id', v_ex, 'saldo', a.saldo - v_imp, 'repetida', false);
end $$;

-- Prepara la liquidación: partidas y anticipo para llamar a confirmar_venta con apartado_id
create or replace function public.preparar_liquidacion(p_apartado uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a apartados%rowtype;
begin
  select * into a from apartados where id = p_apartado;
  perform exigir(a.id is not null and opera_sucursal(a.sucursal_id), 'Apartado no encontrado');
  perform exigir(a.estado = 'abierto', 'El apartado ya está ' || a.estado);
  return jsonb_build_object('apartado_id', a.id, 'sucursal_id', a.sucursal_id, 'almacen_id', a.almacen_id,
    'cliente_id', a.cliente_id, 'lista_id', a.lista_id, 'total', a.total, 'abonado', a.abonado, 'saldo', a.saldo,
    'partidas', (select jsonb_agg(jsonb_build_object('producto_id', producto_id, 'unidad_venta_id', unidad_venta_id,
                   'cantidad', cantidad, 'precio_unitario', precio_unitario, 'descuento', descuento) order by renglon)
                   from apartado_partidas where apartado_id = a.id));
end $$;

-- Cancelar: libera la reserva, retiene el % configurado y devuelve el resto.
-- p_porcentaje: si se indica, debe ser <= al configurado (no se puede retener de más).
create or replace function public.cancelar_apartado(p_apartado uuid, p_motivo text, p_forma_devolucion text default 'efectivo',
  p_porcentaje numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a apartados%rowtype; e empresa%rowtype; v_pct numeric; v_ret numeric; v_dev numeric; r record;
begin
  select * into a from apartados where id = p_apartado for update;
  perform exigir(a.id is not null, 'Apartado no encontrado');
  perform exigir(opera_sucursal(a.sucursal_id), 'No puedes cancelar apartados de esta sucursal');
  perform exigir(tiene_permiso('cancelar_apartados'), 'No tienes permiso para cancelar apartados');
  perform exigir(a.estado = 'abierto', 'El apartado ya está ' || a.estado);
  perform exigir(length(trim(coalesce(p_motivo,''))) > 0, 'El motivo es obligatorio');
  select * into e from empresa where id = 1;

  v_pct := case e.apartado_regla_devolucion when 'devolver_todo' then 0 else e.apartado_porcentaje_retencion end;
  if p_porcentaje is not null then
    perform exigir(p_porcentaje >= 0 and p_porcentaje <= v_pct, format('La retención no puede ser mayor a %s%%', v_pct));
    v_pct := p_porcentaje;
  end if;
  v_ret := round(a.abonado * v_pct / 100, 2);
  v_dev := a.abonado - v_ret;

  perform bloquear_existencias((select coalesce(jsonb_agg(jsonb_build_object('producto_id', producto_id, 'almacen_id', a.almacen_id)), '[]')
                                  from apartado_partidas where apartado_id = a.id));
  for r in select ap.producto_id, sum(ap.cantidad_base) cb from apartado_partidas ap join productos pr on pr.id = ap.producto_id
            where ap.apartado_id = a.id and pr.tipo = 'producto' group by ap.producto_id loop
    update existencias set apartado = apartado - r.cb, actualizado_en = now() where producto_id = r.producto_id and almacen_id = a.almacen_id;
  end loop;

  if v_dev > 0 then
    insert into apartado_pagos (apartado_id, tipo, forma, importe, usuario_id)
    values (a.id, 'devolucion', coalesce(p_forma_devolucion, 'efectivo'), v_dev, auth.uid());
  end if;
  update apartados set estado = 'cancelado', saldo = 0, porcentaje_retencion = v_pct, retenido = v_ret, devuelto = v_dev,
                       motivo_cancelacion = p_motivo, cancelado_en = now(), cancelado_por = auth.uid()
   where id = a.id;
  perform registrar_bitacora('cancelar', 'apartados', a.id::text, to_jsonb(a),
    jsonb_build_object('motivo', p_motivo, 'porcentaje', v_pct, 'retenido', v_ret, 'devuelto', v_dev));
  return jsonb_build_object('retenido', v_ret, 'devuelto', v_dev, 'porcentaje', v_pct);
end $$;

-- ---------------------------------------------------------------------
-- confirmar_venta con soporte de apartados (reemplaza la versión de 0004)
-- Nuevo: p.apartado_id. Acepta los precios del apartado, aplica el anticipo
-- (forma 'anticipo' = abonado del apartado), libera la reserva y descuenta inventario.
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
  v_apa apartados%rowtype;
  v_id uuid := gen_random_uuid(); v_serie text; v_folio bigint;
  r record; c record; v_ren int := 0; v_cb numeric; v_antes numeric; v_costo numeric; v_falt numeric;
  v_pid uuid; v_precio_lista numeric; v_precio_cot numeric; v_desc_cot numeric;
  t_sub numeric := 0; t_desc numeric := 0; t_ieps numeric := 0; t_iva numeric := 0; t_tot numeric := 0;
  v_pagos numeric := 0; v_no_efectivo numeric := 0; v_anticipo numeric := 0; v_cambio numeric := 0; v_saldo numeric := 0;
  v_sc record; v_avisos jsonb := '[]';
begin
  perform exigir(v_key is not null and length(v_key) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('venta:' || v_key, 0));
  select * into v_ex from ventas where idempotency_key = v_key;
  if v_ex.id is not null then
    return jsonb_build_object('venta_id', v_ex.id, 'serie', v_ex.serie, 'folio', v_ex.folio,
                              'total', v_ex.total, 'cambio', v_ex.cambio, 'repetida', true, 'avisos', '[]'::jsonb);
  end if;

  perform exigir(opera_sucursal(v_suc), 'No puedes vender en esta sucursal');
  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null and v_al.activo, 'Almacén no válido');
  perform exigir(v_al.sucursal_id = v_suc or v_al.multisucursal, 'El almacén no pertenece a la sucursal');
  perform exigir(opera_almacen(v_al.id), 'No puedes vender desde este almacén');

  if nullif(p->>'cliente_id','') is null then
    select * into v_cli from clientes where es_publico_general;
  else
    select * into v_cli from clientes where id = (p->>'cliente_id')::uuid;
  end if;
  perform exigir(v_cli.id is not null and v_cli.activo, 'Cliente no válido');

  v_lista := lista_efectiva(nullif(p->>'lista_id','')::uuid, v_cli.id);
  select incluye_impuestos into v_incl from listas_precios where id = v_lista;
  perform exigir(v_lista is not null, 'No hay lista de precios');

  if nullif(p->>'cotizacion_id','') is not null then
    select * into v_cot from cotizaciones where id = (p->>'cotizacion_id')::uuid for update;
    perform exigir(v_cot.id is not null, 'Cotización no encontrada');
    perform exigir(v_cot.estado in ('borrador','enviada'), 'La cotización ya está ' || v_cot.estado);
  end if;

  if nullif(p->>'apartado_id','') is not null then
    select * into v_apa from apartados where id = (p->>'apartado_id')::uuid for update;
    perform exigir(v_apa.id is not null, 'Apartado no encontrado');
    perform exigir(v_apa.estado = 'abierto', 'El apartado ya está ' || v_apa.estado);
    perform exigir(v_apa.cliente_id = v_cli.id, 'El cliente no coincide con el del apartado');
    perform exigir(v_apa.almacen_id = v_al.id, 'La venta debe salir del almacén donde se apartó');
  end if;

  perform bloquear_existencias((
    select coalesce(jsonb_agg(jsonb_build_object('producto_id', pr.id, 'almacen_id', v_al.id)), '[]')
      from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
     where pr.tipo = 'producto'));

  -- Libera la reserva del apartado antes de descontar
  if v_apa.id is not null then
    for r in select ap.producto_id, sum(ap.cantidad_base) cb from apartado_partidas ap join productos pr on pr.id = ap.producto_id
              where ap.apartado_id = v_apa.id and pr.tipo = 'producto' group by ap.producto_id loop
      perform bloquear_existencias(jsonb_build_array(jsonb_build_object('producto_id', r.producto_id, 'almacen_id', v_al.id)));
      update existencias set apartado = apartado - r.cb, actualizado_en = now() where producto_id = r.producto_id and almacen_id = v_al.id;
    end loop;
  end if;

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_suc, 'venta') s;

  insert into ventas (id, sucursal_id, almacen_id, caja_id, serie, folio, cliente_id, vendedor_id, lista_id, tipo,
                      subtotal, descuento, ieps, iva, total, cotizacion_id, apartado_id, comentarios, idempotency_key)
  values (v_id, v_suc, v_al.id, nullif(p->>'caja_id','')::uuid, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, v_tipo,
          0, 0, 0, 0, 0, v_cot.id, v_apa.id, p->>'comentarios', v_key);

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

    -- Precio aceptado: lista, cotizado, apartado (congelado) o con permiso
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    v_precio_cot := null; v_desc_cot := 0;
    if v_cot.id is not null then
      select precio_unitario, descuento into v_precio_cot, v_desc_cot from cotizacion_partidas
       where cotizacion_id = v_cot.id and unidad_venta_id = r.unidad_id order by renglon limit 1;
    elsif v_apa.id is not null then
      select precio_unitario, descuento into v_precio_cot, v_desc_cot from apartado_partidas
       where apartado_id = v_apa.id and unidad_venta_id = r.unidad_id order by renglon limit 1;
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

  for r in select x->>'forma' forma, (x->>'importe')::numeric importe, x->>'referencia' referencia
             from jsonb_array_elements(coalesce(p->'pagos', '[]')) x
  loop
    perform exigir(r.importe > 0, 'Importe de pago inválido');
    if r.forma = 'anticipo' then
      perform exigir(v_apa.id is not null, 'La forma "anticipo" solo aplica al liquidar un apartado');
      v_anticipo := v_anticipo + r.importe;
    end if;
    insert into venta_pagos (venta_id, forma, importe, referencia) values (v_id, r.forma, r.importe, r.referencia);
    v_pagos := v_pagos + r.importe;
    if r.forma <> 'efectivo' then v_no_efectivo := v_no_efectivo + r.importe; end if;
  end loop;
  perform exigir(v_no_efectivo <= t_tot, 'Los pagos con tarjeta, transferencia o anticipo exceden el total');
  if v_apa.id is not null then
    perform exigir(v_anticipo = v_apa.abonado, format('Debe aplicarse el anticipo completo del apartado (%s)', v_apa.abonado));
  end if;

  if v_tipo = 'contado' then
    perform exigir(v_pagos >= t_tot, 'El pago no cubre el total de la venta');
    v_cambio := v_pagos - t_tot;
    v_saldo := 0;
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
  if v_apa.id is not null then
    update apartados set estado = 'liquidado', venta_id = v_id, saldo = 0 where id = v_apa.id;
  end if;

  return jsonb_build_object('venta_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', t_tot,
                            'cambio', v_cambio, 'saldo', v_saldo, 'repetida', false, 'avisos', v_avisos);
end $$;

-- ---------- Seguridad ----------
alter table public.apartados enable row level security;
alter table public.apartados force row level security;
alter table public.apartado_partidas enable row level security;
alter table public.apartado_partidas force row level security;
alter table public.apartado_pagos enable row level security;
alter table public.apartado_pagos force row level security;
revoke all on public.apartados, public.apartado_partidas, public.apartado_pagos from anon;
revoke insert, update, delete, truncate, references, trigger on public.apartados, public.apartado_partidas, public.apartado_pagos from authenticated;
grant select on public.apartados, public.apartado_partidas, public.apartado_pagos, public.v_apartados to authenticated;
create policy apartados_sel on public.apartados for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy apartado_partidas_sel on public.apartado_partidas for select to authenticated
  using (exists (select 1 from public.apartados a where a.id = apartado_id and public.opera_sucursal(a.sucursal_id)));
create policy apartado_pagos_sel on public.apartado_pagos for select to authenticated
  using (exists (select 1 from public.apartados a where a.id = apartado_id and public.opera_sucursal(a.sucursal_id)));

revoke execute on function public.crear_apartado(jsonb), public.abonar_apartado(jsonb), public.preparar_liquidacion(uuid),
  public.cancelar_apartado(uuid, text, text, numeric), public.confirmar_venta(jsonb) from public, anon;
grant execute on function public.crear_apartado(jsonb), public.abonar_apartado(jsonb), public.preparar_liquidacion(uuid),
  public.cancelar_apartado(uuid, text, text, numeric), public.confirmar_venta(jsonb) to authenticated;
