-- =============================================================================
-- 0019 · Venta de pisos por M2
-- Los pisos se venden por CAJA, PIEZA o M2. M2 tiene factor = piezas por m² y precio = precio por m².
-- La existencia sigue en piezas: una cantidad en M2 debe equivaler a piezas completas (la pantalla
-- la ajusta hacia arriba, p. ej. 10 m² -> 10.08 m² = 112 piezas). En general, un producto que no
-- admite fracciones exige que la cantidad equivalga a unidades base completas (antes se exigía
-- que la cantidad vendida fuera entera, lo que impedía vender por M2).
-- Se puede ejecutar más de una vez.
-- =============================================================================

-- Cantidad en unidad base. Sin fracciones: debe dar unidades completas (tolerancia por redondeo del factor).
create or replace function public.cantidad_base_de(p_cantidad numeric, p_factor numeric, p_fraccion boolean, p_nombre text)
returns numeric language plpgsql immutable as $$
declare b numeric := p_cantidad * p_factor;
begin
  if p_fraccion then return round(b, 6); end if;
  if abs(b - round(b)) > 0.0005 then
    raise exception '%: la cantidad debe equivaler a piezas o unidades completas', coalesce(p_nombre, 'Producto');
  end if;
  return round(b);
end $$;

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
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    perform exigir(r.precio = coalesce(v_precio_lista, r.precio) or tiene_permiso('modificar_precios'),
                   'No tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), 'No tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, v_incl);
    insert into cotizacion_partidas (cotizacion_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, 'Producto'),
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
    select precio into v_precio_lista from precios where lista_id = v_lista and unidad_venta_id = r.unidad_id;
    perform exigir(r.precio = v_precio_lista or tiene_permiso('modificar_precios'), r.producto_nombre || ': no tienes permiso para cambiar el precio');
    perform exigir(r.descuento = 0 or tiene_permiso('aplicar_descuentos'), r.producto_nombre || ': no tienes permiso para aplicar descuentos');
    v_ren := v_ren + 1;
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, v_incl);
    insert into apartado_partidas (apartado_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad, cantidad_base,
      precio_unitario, descuento, iva_tasa, ieps_tasa, subtotal, ieps, iva, total)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre),
      r.precio, r.descuento, r.iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total);
    -- Reserva: no descuenta, solo aparta
    if r.tipo = 'producto' then
      update existencias set apartado = apartado + cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre), actualizado_en = now()
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
  -- Remisión sin IVA (predeterminado): el precio es el importe final y la tasa de IVA queda en 0
  v_sin_iva boolean := coalesce((p->>'sin_iva')::boolean, true);
  v_iva_tasa numeric;
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
                      subtotal, descuento, ieps, iva, total, cotizacion_id, apartado_id, comentarios, idempotency_key, sin_iva)
  values (v_id, v_suc, v_al.id, nullif(p->>'caja_id','')::uuid, v_serie, v_folio, v_cli.id, auth.uid(), v_lista, v_tipo,
          0, 0, 0, 0, 0, v_cot.id, v_apa.id, p->>'comentarios', v_key, v_sin_iva);

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
    v_iva_tasa := case when v_sin_iva then 0 else r.iva_tasa end;
    v_cb := cantidad_base_de(r.cantidad, r.factor, r.permite_fraccion, r.producto_nombre);
    select * into c from calcular_partida(r.cantidad, r.precio, r.descuento, v_iva_tasa, r.ieps_tasa, v_incl);
    v_costo := coalesce(costo_venta(r.producto_id), 0);

    insert into venta_partidas (venta_id, renglon, producto_id, unidad_venta_id, unidad_nombre, factor, cantidad,
      cantidad_base, cantidad_entregada, precio_unitario, precio_lista, descuento, iva_tasa, ieps_tasa,
      subtotal, ieps, iva, total, costo_unitario_base)
    values (v_id, v_ren, r.producto_id, r.unidad_id, r.unidad_nombre, r.factor, r.cantidad, v_cb,
      case when r.entregar_ahora then r.cantidad else 0 end, r.precio, v_precio_lista, r.descuento,
      v_iva_tasa, r.ieps_tasa, c.subtotal, c.ieps, c.iva, c.total, v_costo)
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

create or replace function public.guardar_producto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid := nullif(p->>'id','')::uuid;
  v_ant productos%rowtype;
  v_pres text := coalesce(nullif(p->>'presentacion',''), 'unidad');
  v_nombre text := trim(coalesce(p->>'nombre',''));
  v_marca uuid := marca_por_nombre(p->>'marca');
  v_cat uuid := categoria_por_nombre(p->>'categoria');
  v_formato text := nullif(trim(p->>'formato'),'');
  v_sku text := nullif(upper(trim(p->>'sku')),'');
  v_unidad text := upper(coalesce(nullif(trim(p->>'unidad'),''), 'PIEZA'));
  v_piezas int := nullif(p->>'piezas_por_caja','')::int;
  v_m2 numeric := nullif(p->>'m2_por_caja','')::numeric;
  v_pm2 numeric := nullif(p->>'precio_m2','')::numeric;
  v_lista uuid; v_caja uuid; v_base uuid; v_um2 uuid;
  v_pcaja numeric; v_ppieza numeric; v_precio numeric;
  v_nuevo boolean := v_id is null;
begin
  perform exigir(tiene_permiso('editar_productos'), 'No tienes permiso para dar de alta o editar productos');
  perform exigir(v_pres in ('piso','unidad'), 'Presentación no válida');
  perform exigir(coalesce((p->>'iva_tasa')::numeric, 0) in (0, 0.08, 0.16), 'Tasa de IVA no válida');
  select id into v_lista from listas_precios where predeterminada;
  perform exigir(v_lista is not null, 'No hay lista de precios predeterminada');

  if v_pres = 'piso' then
    perform exigir(v_piezas is not null, 'Piso: indica las piezas por caja');
    perform exigir(v_m2 is not null, 'Piso: indica los m² por caja');
    v_unidad := 'PIEZA';
  else
    perform exigir(v_unidad ~ '^[A-Z0-9]{1,10}$', 'Unidad no válida (p. ej. PIEZA, BULTO, KG)');
  end if;

  if not v_nuevo then
    select * into v_ant from productos where id = v_id for update;
    perform exigir(v_ant.id is not null, 'Producto no encontrado');
    perform exigir(v_ant.presentacion = v_pres and v_ant.unidad_base = v_unidad,
                   'No se puede cambiar la presentación ni la unidad de un producto ya creado; da de alta uno nuevo');
  end if;

  if v_sku is null then
    v_sku := case when v_nuevo then generar_sku(v_marca, v_cat, v_formato) else v_ant.sku end;
  end if;
  perform exigir(v_sku ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$', 'SKU no válido: ' || v_sku);
  if length(v_nombre) = 0 then   -- sin descripción: marca + formato + SKU
    v_nombre := concat_ws(' ', (select nombre from marcas where id = v_marca), v_formato, v_sku);
  end if;
  perform exigir(not exists (select 1 from productos where sku = v_sku and id is distinct from v_id), 'Ya existe un producto con el SKU ' || v_sku);
  perform exigir(nullif(trim(p->>'codigo_barras'),'') is null or not exists (
                   select 1 from productos where codigo_barras = trim(p->>'codigo_barras') and id is distinct from v_id),
                 'Ese código de barras ya está en otro producto');

  if v_nuevo then
    insert into productos (sku, codigo_barras, nombre, descripcion, categoria_id, marca_id, tipo, imagen_url, activo,
                           unidad_base, clave_sat_prodserv, clave_sat_unidad, iva_tasa, permite_fraccion,
                           formato, presentacion, piezas_por_caja, m2_por_caja, precio_m2, comentarios)
    values (v_sku, nullif(trim(p->>'codigo_barras'),''), v_nombre, nullif(trim(p->>'descripcion'),''), v_cat, v_marca,
            coalesce(nullif(p->>'tipo',''), 'producto'), nullif(trim(p->>'imagen_url'),''), coalesce((p->>'activo')::boolean, true),
            v_unidad, coalesce(nullif(trim(p->>'clave_sat_prodserv'),''), case when v_pres = 'piso' then '30161602' else '01010101' end),
            case v_unidad when 'PIEZA' then 'H87' when 'KG' then 'KGM' when 'LITRO' then 'LTR' when 'METRO' then 'MTR'
                          when 'M2' then 'MTK' when 'ROLLO' then 'XRO' when 'BULTO' then 'XBG' when 'CAJA' then 'XBX' else 'H87' end,
            coalesce((p->>'iva_tasa')::numeric, 0), coalesce((p->>'permite_fraccion')::boolean, v_unidad in ('KG','LITRO','METRO','M2')),
            v_formato, v_pres, v_piezas, v_m2, v_pm2, nullif(trim(p->>'comentarios'),''))
    returning id into v_id;   -- el trigger crea la unidad base
  else
    update productos set sku = v_sku, codigo_barras = nullif(trim(p->>'codigo_barras'),''), nombre = v_nombre,
           descripcion = nullif(trim(p->>'descripcion'),''), categoria_id = v_cat, marca_id = v_marca,
           imagen_url = coalesce(nullif(trim(p->>'imagen_url'),''), imagen_url),
           activo = coalesce((p->>'activo')::boolean, activo),
           clave_sat_prodserv = coalesce(nullif(trim(p->>'clave_sat_prodserv'),''), clave_sat_prodserv),
           iva_tasa = coalesce((p->>'iva_tasa')::numeric, iva_tasa),
           formato = v_formato, piezas_por_caja = v_piezas, m2_por_caja = v_m2, precio_m2 = coalesce(v_pm2, precio_m2),
           comentarios = nullif(trim(p->>'comentarios'),''), actualizado_en = now()
     where id = v_id;
  end if;

  select id into v_base from unidades_venta where producto_id = v_id and es_base;

  if v_pres = 'piso' then
    insert into unidades_venta (producto_id, nombre, factor, es_base, clave_sat_unidad, orden)
    values (v_id, 'CAJA', v_piezas, false, 'XBX', 1)
    on conflict (producto_id, nombre) do update set factor = excluded.factor, activa = true
    returning id into v_caja;
    -- M2: se vende por metro cuadrado; factor = piezas por m² (la cantidad se ajusta a piezas completas)
    insert into unidades_venta (producto_id, nombre, factor, es_base, clave_sat_unidad, orden)
    values (v_id, 'M2', v_piezas / v_m2, false, 'MTK', 3)
    on conflict (producto_id, nombre) do update set factor = excluded.factor, activa = true
    returning id into v_um2;
    update unidades_venta set orden = 2 where id = v_base;
    -- Precios: capturados, o calculados desde el precio por m²
    v_pcaja  := coalesce(nullif(p->>'precio_caja','')::numeric, v_m2 * v_pm2);   -- sin redondear (ver 0016)
    -- Pieza = área de la pieza (m² por caja ÷ piezas) × precio m², sin redondear; si la caja se capturó a mano, caja ÷ piezas
    v_ppieza := coalesce(nullif(p->>'precio_pieza','')::numeric,
                         case when nullif(p->>'precio_caja','') is null and v_pm2 is not null
                              then v_m2 / v_piezas * v_pm2 else v_pcaja / v_piezas end);
    -- Sin precio: el producto se da de alta igual (se captura después); si ya tenía, se conserva
    if v_pcaja is not null then
      perform exigir(v_pcaja >= 0 and v_ppieza >= 0, 'El precio no puede ser negativo');
      insert into precios (lista_id, unidad_venta_id, precio)
      values (v_lista, v_caja, v_pcaja), (v_lista, v_base, v_ppieza), (v_lista, v_um2, coalesce(v_pm2, v_pcaja / v_m2))
      on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
    end if;
  else
    v_precio := nullif(p->>'precio','')::numeric;
    if v_precio is not null then
      perform exigir(v_precio >= 0, 'El precio no puede ser negativo');
      insert into precios (lista_id, unidad_venta_id, precio) values (v_lista, v_base, v_precio)
      on conflict (lista_id, unidad_venta_id) do update set precio = excluded.precio, actualizado_en = now();
    end if;
  end if;

  perform registrar_bitacora(case when v_nuevo then 'crear' else 'actualizar' end, 'productos', v_id::text,
                             case when v_nuevo then null else to_jsonb(v_ant) end, p);
  return jsonb_build_object('producto_id', v_id, 'sku', v_sku, 'nuevo', v_nuevo);
end $$;

-- Agrega la unidad M2 (y su precio) a los pisos ya dados de alta
insert into public.unidades_venta (producto_id, nombre, factor, es_base, clave_sat_unidad, orden)
select id, 'M2', piezas_por_caja / m2_por_caja, false, 'MTK', 3
  from public.productos where presentacion = 'piso' and piezas_por_caja is not null and m2_por_caja is not null
on conflict (producto_id, nombre) do update set factor = excluded.factor, activa = true;

insert into public.precios (lista_id, unidad_venta_id, precio)
select l.id, u.id, coalesce(p.precio_m2, pc.precio / p.m2_por_caja)
  from public.productos p
  join public.unidades_venta u on u.producto_id = p.id and u.nombre = 'M2'
  join public.listas_precios l on l.predeterminada
  left join public.unidades_venta uc on uc.producto_id = p.id and uc.nombre = 'CAJA'
  left join public.precios pc on pc.unidad_venta_id = uc.id and pc.lista_id = l.id
 where p.presentacion = 'piso' and coalesce(p.precio_m2, pc.precio) is not null
on conflict (lista_id, unidad_venta_id) do nothing;
