-- =============================================================================
-- 0047 · Recepción de mercancía (entradas de proveedor) y proveedores.
--   · registrar_entrada: crea la serie de entradas si falta (código de sucursal + E), valida proveedor
--     y no acepta servicios. Datos del documento del proveedor: tipo (factura/remisión/otro), número,
--     fecha y días de crédito; IVA por renglón y descuento global. El costo que entra al promedio es
--     sin IVA y con el descuento repartido proporcionalmente. Sigue subiendo existencias, calculando el costo promedio
--     y corrigiendo el costo de lo vendido sin existencia.
--   · cancelar_entrada: saca del inventario lo recibido y revierte el costo promedio (si la mercancía
--     sigue en el almacén).
--   · guardar_proveedor: alta y edición de proveedores (administrar o recibir mercancía).
-- Requiere 0046. Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.entradas add column if not exists total numeric(14,2) not null default 0;
alter table public.entradas add column if not exists subtotal numeric(14,2) not null default 0;
alter table public.entradas add column if not exists descuento numeric(14,2) not null default 0;
alter table public.entradas add column if not exists iva numeric(14,2) not null default 0;
alter table public.entradas add column if not exists tipo_documento text check (tipo_documento in ('factura','remision','otro'));
alter table public.entradas add column if not exists fecha_documento date;
alter table public.entradas add column if not exists dias_credito integer not null default 0;
alter table public.entrada_partidas add column if not exists iva_tasa numeric(6,4) not null default 0;
alter table public.entradas add column if not exists cancelada_en timestamptz;
alter table public.entradas add column if not exists cancelada_por uuid;
alter table public.entradas add column if not exists motivo_cancelacion text;
update public.entradas e set subtotal = x.s, total = x.s
  from (select entrada_id, coalesce(sum(round(cantidad * costo_unitario, 2)), 0) s from public.entrada_partidas group by entrada_id) x
 where x.entrada_id = e.id and e.total = 0;

-- Kardex: tipo de movimiento para la cancelación de una entrada
alter table public.movimientos drop constraint if exists movimientos_tipo_check;
alter table public.movimientos add constraint movimientos_tipo_check check (tipo in (
  'inventario_inicial','entrada','venta','cancelacion_venta','devolucion',
  'ajuste','traspaso_salida','traspaso_entrada','cancelacion_traspaso','cancelacion_entrada'));

create or replace function public.registrar_entrada(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_almacen almacenes%rowtype; v_id uuid; v_serie text; v_folio bigint;
  r record; v_antes numeric; v_costo_base numeric; v_cant_base numeric;
  v_prod productos%rowtype; v_existente uuid; v_pend record; v_usar numeric; v_restante numeric; v_total numeric := 0;
  v_sub numeric := 0; v_iva numeric := 0; v_desc numeric := greatest(coalesce(nullif(p->>'descuento','')::numeric, 0), 0); v_k numeric := 1;
begin
  select id into v_existente from entradas where idempotency_key = p->>'idempotency_key';
  if v_existente is not null then
    return jsonb_build_object('entrada_id', v_existente, 'repetida', true);
  end if;

  select * into v_almacen from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_almacen.id is not null, 'Almacén no encontrado');
  perform exigir(opera_almacen(v_almacen.id), 'No puedes registrar entradas en este almacén');
  perform exigir(tiene_permiso('recibir_mercancia'), 'No tienes permiso para registrar entradas');
  perform exigir(jsonb_array_length(coalesce(p->'partidas','[]')) > 0, 'La entrada no tiene partidas');
  perform exigir(coalesce(nullif(p->>'tipo_documento',''), 'factura') in ('factura','remision','otro'), 'Tipo de documento no válido');
  -- Subtotal antes del descuento, para repartirlo en el costo de cada renglón
  select coalesce(sum(round((x->>'cantidad')::numeric * (x->>'costo_unitario')::numeric, 2)), 0) into v_sub from jsonb_array_elements(p->'partidas') x;
  perform exigir(v_desc <= v_sub, 'El descuento es mayor al subtotal');
  if v_sub > 0 then v_k := (v_sub - v_desc) / v_sub; end if;
  perform exigir(nullif(p->>'proveedor_id','') is null or exists (select 1 from proveedores where id = (p->>'proveedor_id')::uuid),
                 'Proveedor no válido');
  perform exigir(not exists (select 1 from jsonb_array_elements(p->'partidas') x join productos pr on pr.id = (x->>'producto_id')::uuid
                              where pr.tipo <> 'producto'),
                 'Los servicios y conceptos no se reciben en inventario');

  perform bloquear_existencias((select jsonb_agg(jsonb_build_object('producto_id', x->>'producto_id', 'almacen_id', v_almacen.id))
                                  from jsonb_array_elements(p->'partidas') x));

  -- Si la sucursal no tiene serie de entradas, se crea (código de sucursal + E)
  insert into series (sucursal_id, tipo_documento, prefijo)
  select v_almacen.sucursal_id, 'entrada', su.codigo || 'E' from sucursales su
   where su.id = v_almacen.sucursal_id
     and not exists (select 1 from series where sucursal_id = v_almacen.sucursal_id and tipo_documento = 'entrada' and activa)
  on conflict do nothing;
  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_almacen.sucursal_id, 'entrada') s;
  insert into entradas (sucursal_id, almacen_id, proveedor_id, serie, folio, documento_proveedor, usuario_id, comentarios, idempotency_key,
                        tipo_documento, fecha_documento, dias_credito)
  values (v_almacen.sucursal_id, v_almacen.id, nullif(p->>'proveedor_id','')::uuid, v_serie, v_folio,
          nullif(trim(p->>'documento_proveedor'), ''), auth.uid(), nullif(trim(p->>'comentarios'), ''), p->>'idempotency_key',
          coalesce(nullif(p->>'tipo_documento',''), 'factura'), nullif(p->>'fecha_documento','')::date,
          coalesce(nullif(p->>'dias_credito','')::int, (select dias_credito from proveedores where id = nullif(p->>'proveedor_id','')::uuid), 0))
  returning id into v_id;

  for r in
    select (x->>'producto_id')::uuid producto_id, (x->>'unidad_venta_id')::uuid unidad_venta_id,
           (x->>'cantidad')::numeric cantidad, (x->>'costo_unitario')::numeric costo_unitario, x->>'lote' lote,
           coalesce(nullif(x->>'iva_tasa','')::numeric, 0) iva_tasa,
           u.factor, u.producto_id as u_producto
      from jsonb_array_elements(p->'partidas') x
      join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
  loop
    perform exigir(r.u_producto = r.producto_id, 'La unidad no corresponde al producto');
    perform exigir(r.cantidad > 0 and r.costo_unitario >= 0, 'Cantidad o costo inválido');
    perform exigir(r.iva_tasa in (0, 0.08, 0.16), 'Tasa de IVA no válida');
    v_cant_base := round(r.cantidad * r.factor, 6);
    -- costo por unidad base, sin IVA y con el descuento global repartido
    v_costo_base := round(r.costo_unitario * v_k / r.factor, 6);
    v_iva := v_iva + round(r.cantidad * r.costo_unitario * v_k * r.iva_tasa, 2);

    insert into entrada_partidas (entrada_id, producto_id, unidad_venta_id, cantidad, factor, cantidad_base, costo_unitario, lote, iva_tasa)
    values (v_id, r.producto_id, r.unidad_venta_id, r.cantidad, r.factor, v_cant_base, r.costo_unitario, r.lote, r.iva_tasa);

    v_antes := mover_inventario(r.producto_id, v_almacen.id, v_cant_base, 'entrada', 'entrada', v_id, v_costo_base);

    -- Costo promedio ponderado: solo la existencia positiva previa pondera
    select * into v_prod from productos where id = r.producto_id for update;
    if v_prod.costo_metodo = 'promedio' then
      update productos set
        costo_promedio = round((greatest(v_antes,0) * v_prod.costo_promedio + v_cant_base * v_costo_base)
                               / nullif(greatest(v_antes,0) + v_cant_base, 0), 6),
        ultimo_costo = v_costo_base, actualizado_en = now()
      where id = r.producto_id;
    else
      update productos set ultimo_costo = v_costo_base, actualizado_en = now() where id = r.producto_id;
    end if;

    -- Corrige el costo de lo vendido sin existencia (FIFO)
    v_restante := v_cant_base;
    for v_pend in
      select * from costo_pendiente
       where producto_id = r.producto_id and almacen_id = v_almacen.id and cantidad_pendiente > 0
       order by id for update
    loop
      exit when v_restante <= 0;
      v_usar := least(v_restante, v_pend.cantidad_pendiente);
      insert into ajustes_costo_venta (venta_partida_id, entrada_id, cantidad, costo_usado, costo_real, diferencia)
      values (v_pend.venta_partida_id, v_id, v_usar, v_pend.costo_usado, v_costo_base,
              round((v_costo_base - v_pend.costo_usado) * v_usar, 2));
      update costo_pendiente set cantidad_pendiente = cantidad_pendiente - v_usar where id = v_pend.id;
      v_restante := v_restante - v_usar;
    end loop;
  end loop;

  v_total := v_sub - v_desc + v_iva;
  update entradas set subtotal = v_sub, descuento = v_desc, iva = v_iva, total = v_total where id = v_id;
  perform registrar_bitacora('crear', 'entradas', v_id::text, null, jsonb_build_object('total', v_total, 'documento', p->>'documento_proveedor'));
  return jsonb_build_object('entrada_id', v_id, 'serie', v_serie, 'folio', v_folio, 'total', v_total, 'repetida', false);
end $$;

-- {entrada_id, motivo}
create or replace function public.cancelar_entrada(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e entradas%rowtype; r record; v_antes numeric; v_prod productos%rowtype; v_costo_base numeric; v_resto numeric;
begin
  select * into e from entradas where id = (p->>'entrada_id')::uuid for update;
  perform exigir(e.id is not null, 'Entrada no encontrada');
  perform exigir(e.estado = 'aplicada', 'La entrada ya está cancelada');
  perform exigir(opera_almacen(e.almacen_id) and tiene_permiso('recibir_mercancia'), 'No tienes permiso para cancelar entradas en este almacén');
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'Indica el motivo de la cancelación');
  perform exigir(not exists (select 1 from ajustes_costo_venta where entrada_id = e.id),
                 'Esta entrada ya corrigió el costo de ventas hechas sin existencia; corrige con un ajuste de inventario');
  perform bloquear_existencias((select jsonb_agg(distinct jsonb_build_object('producto_id', producto_id, 'almacen_id', e.almacen_id))
                                  from entrada_partidas where entrada_id = e.id));
  for r in select ep.producto_id, sum(ep.cantidad_base) cb,
                  sum(ep.cantidad_base * ep.costo_unitario / ep.factor) * case when e.subtotal > 0 then (e.subtotal - e.descuento) / e.subtotal else 1 end costo_total,
                  (select pr.nombre from productos pr where pr.id = ep.producto_id) nombre
             from entrada_partidas ep where ep.entrada_id = e.id group by ep.producto_id
  loop
    perform exigir(coalesce((select cantidad from existencias where producto_id = r.producto_id and almacen_id = e.almacen_id), 0) >= r.cb,
                   r.nombre || ': ya no hay existencia suficiente en el almacén para cancelar la entrada (se vendió o se movió); corrige con un ajuste');
    v_costo_base := case when r.cb > 0 then r.costo_total / r.cb else 0 end;
    v_antes := mover_inventario(r.producto_id, e.almacen_id, -r.cb, 'cancelacion_entrada', 'entrada', e.id, v_costo_base,
                                'Cancelación: ' || trim(p->>'motivo'));
    -- Revierte el costo promedio con la existencia total del producto (todas las bodegas)
    select * into v_prod from productos where id = r.producto_id for update;
    if v_prod.costo_metodo = 'promedio' then
      select coalesce(sum(greatest(cantidad, 0)), 0) into v_resto from existencias where producto_id = r.producto_id;
      if v_resto > 0 then
        update productos set costo_promedio = greatest(round((v_prod.costo_promedio * (v_resto + r.cb) - r.costo_total) / v_resto, 6), 0),
                             actualizado_en = now() where id = r.producto_id;
      end if;
    end if;
  end loop;
  update entradas set estado = 'cancelada', cancelada_en = now(), cancelada_por = auth.uid(), motivo_cancelacion = trim(p->>'motivo') where id = e.id;
  perform registrar_bitacora('cancelar', 'entradas', e.id::text, to_jsonb(e), jsonb_build_object('motivo', p->>'motivo'));
  return jsonb_build_object('entrada_id', e.id, 'estado', 'cancelada');
end $$;

-- {id?, nombre, rfc?, contacto?, telefono?, correo?, dias_credito?, activo?}
create or replace function public.guardar_proveedor(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_rfc text := nullif(upper(trim(p->>'rfc')), '');
begin
  perform exigir(tiene_permiso('administrar') or tiene_permiso('recibir_mercancia'), 'No tienes permiso para editar proveedores');
  perform exigir(length(trim(coalesce(p->>'nombre',''))) > 0, 'Escribe el nombre del proveedor');
  perform exigir(v_rfc is null or v_rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$', 'El RFC no es válido');
  perform exigir(not exists (select 1 from proveedores where lower(nombre) = lower(trim(p->>'nombre')) and id is distinct from v_id),
                 'Ya existe un proveedor con ese nombre');
  if v_id is null then
    insert into proveedores (nombre, rfc, contacto, telefono, correo, dias_credito)
    values (trim(p->>'nombre'), v_rfc, nullif(trim(p->>'contacto'),''), nullif(trim(p->>'telefono'),''), nullif(trim(p->>'correo'),''),
            coalesce(nullif(p->>'dias_credito','')::int, 0))
    returning id into v_id;
  else
    update proveedores set nombre = trim(p->>'nombre'), rfc = v_rfc, contacto = nullif(trim(p->>'contacto'),''),
           telefono = nullif(trim(p->>'telefono'),''), correo = nullif(trim(p->>'correo'),''),
           dias_credito = coalesce(nullif(p->>'dias_credito','')::int, dias_credito), activo = coalesce((p->>'activo')::boolean, activo)
     where id = v_id;
    perform exigir(found, 'Proveedor no encontrado');
  end if;
  return jsonb_build_object('proveedor_id', v_id);
end $$;

revoke execute on function public.registrar_entrada(jsonb), public.cancelar_entrada(jsonb), public.guardar_proveedor(jsonb) from public, anon;
grant execute on function public.registrar_entrada(jsonb), public.cancelar_entrada(jsonb), public.guardar_proveedor(jsonb) to authenticated;
