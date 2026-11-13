-- =====================================================================
-- 0003 · Inventario: existencias, kardex inmutable, costo con existencia
-- negativa, entradas de mercancía, traspasos y ajustes.
-- Regla: la existencia NUNCA se edita directo; solo mover_inventario().
-- =====================================================================

create table public.existencias (
  producto_id uuid not null references public.productos(id),
  almacen_id  uuid not null references public.almacenes(id),
  cantidad    numeric(18,6) not null default 0,   -- puede ser negativa
  apartado    numeric(18,6) not null default 0 check (apartado >= 0),
  actualizado_en timestamptz not null default now(),
  primary key (producto_id, almacen_id)
);
create index existencias_almacen on public.existencias (almacen_id);

create table public.movimientos (
  id              bigserial primary key,
  fecha           timestamptz not null default now(),
  producto_id     uuid not null references public.productos(id),
  almacen_id      uuid not null references public.almacenes(id),
  tipo            text not null check (tipo in (
                    'inventario_inicial','entrada','venta','cancelacion_venta','devolucion',
                    'ajuste','traspaso_salida','traspaso_entrada','cancelacion_traspaso')),
  cantidad        numeric(18,6) not null check (cantidad <> 0),  -- con signo, en unidad base
  costo_unitario  numeric(18,6) not null default 0,
  saldo           numeric(18,6) not null,                         -- existencia después del movimiento
  documento_tipo  text not null,
  documento_id    uuid not null,
  usuario_id      uuid,
  nota            text
);
create index movimientos_producto_fecha on public.movimientos (producto_id, almacen_id, fecha);
create index movimientos_documento on public.movimientos (documento_tipo, documento_id);
create index movimientos_fecha on public.movimientos (fecha);

-- Kardex inmutable
create or replace function public.trg_inmutable()
returns trigger language plpgsql as $$
begin
  raise exception 'La tabla % es inmutable: registra un movimiento inverso en lugar de modificar', tg_table_name;
end $$;
create trigger movimientos_inmutable before update or delete on public.movimientos
  for each row execute function public.trg_inmutable();

-- Ventas que dejaron existencia negativa y esperan costo real (decisión D5)
create table public.costo_pendiente (
  id                 bigserial primary key,
  producto_id        uuid not null references public.productos(id),
  almacen_id         uuid not null references public.almacenes(id),
  venta_partida_id   uuid,                 -- FK se agrega en 0004
  cantidad_pendiente numeric(18,6) not null check (cantidad_pendiente >= 0),
  costo_usado        numeric(18,6) not null,
  creado_en          timestamptz not null default now()
);
create index costo_pendiente_abiertos on public.costo_pendiente (producto_id, almacen_id, id) where cantidad_pendiente > 0;

create table public.ajustes_costo_venta (
  id               bigserial primary key,
  fecha            timestamptz not null default now(),
  venta_partida_id uuid,
  entrada_id       uuid,
  cantidad         numeric(18,6) not null,
  costo_usado      numeric(18,6) not null,
  costo_real       numeric(18,6) not null,
  diferencia       numeric(14,2) not null   -- (costo_real - costo_usado) * cantidad
);

-- ---------------------------------------------------------------------
-- Núcleo: mueve inventario de UNA fila de existencia (bloqueada) y deja kardex
-- Solo lo llaman otras funciones; no se expone a los clientes.
-- ---------------------------------------------------------------------
create or replace function public.mover_inventario(
  p_producto uuid, p_almacen uuid, p_cantidad numeric, p_tipo text,
  p_doc_tipo text, p_doc_id uuid, p_costo numeric, p_nota text default null)
returns numeric  -- existencia ANTES del movimiento
language plpgsql security definer set search_path = public as $$
declare v_antes numeric(18,6);
begin
  insert into existencias (producto_id, almacen_id) values (p_producto, p_almacen)
  on conflict do nothing;
  select cantidad into v_antes from existencias
   where producto_id = p_producto and almacen_id = p_almacen for update;

  update existencias set cantidad = cantidad + p_cantidad, actualizado_en = now()
   where producto_id = p_producto and almacen_id = p_almacen;

  insert into movimientos (producto_id, almacen_id, tipo, cantidad, costo_unitario, saldo,
                           documento_tipo, documento_id, usuario_id, nota)
  values (p_producto, p_almacen, p_tipo, p_cantidad, coalesce(p_costo, 0), v_antes + p_cantidad,
          p_doc_tipo, p_doc_id, auth.uid(), p_nota);
  return v_antes;
end $$;
revoke all on function public.mover_inventario(uuid,uuid,numeric,text,text,uuid,numeric,text) from public;

-- Bloquea en orden estable todas las filas de existencia de un conjunto (evita interbloqueos)
create or replace function public.bloquear_existencias(p_pares jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into existencias (producto_id, almacen_id)
  select distinct (x->>'producto_id')::uuid, (x->>'almacen_id')::uuid from jsonb_array_elements(p_pares) x
  on conflict do nothing;
  perform 1 from existencias e
   where (e.producto_id, e.almacen_id) in (
     select (x->>'producto_id')::uuid, (x->>'almacen_id')::uuid from jsonb_array_elements(p_pares) x)
   order by e.producto_id, e.almacen_id
   for update;
end $$;
revoke all on function public.bloquear_existencias(jsonb) from public;

-- Costo que se usa al vender: promedio; si es 0, último costo conocido
create or replace function public.costo_venta(p_producto uuid)
returns numeric language sql stable as $$
  select case when costo_promedio > 0 then costo_promedio else ultimo_costo end
    from productos where id = p_producto;
$$;

-- ---------------------------------------------------------------------
-- Entradas de mercancía
-- ---------------------------------------------------------------------
create table public.entradas (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  almacen_id       uuid not null references public.almacenes(id),
  proveedor_id     uuid references public.proveedores(id),
  serie            text not null,
  folio            bigint not null,
  documento_proveedor text,
  fecha            timestamptz not null default now(),
  usuario_id       uuid,
  estado           text not null default 'aplicada' check (estado in ('aplicada','cancelada')),
  comentarios      text,
  idempotency_key  text unique,
  unique (sucursal_id, serie, folio)
);

create table public.entrada_partidas (
  id              uuid primary key default gen_random_uuid(),
  entrada_id      uuid not null references public.entradas(id),
  producto_id     uuid not null references public.productos(id),
  unidad_venta_id uuid not null references public.unidades_venta(id),
  cantidad        numeric(18,6) not null check (cantidad > 0),
  factor          numeric(18,8) not null,
  cantidad_base   numeric(18,6) not null,
  costo_unitario  numeric(18,6) not null check (costo_unitario >= 0),  -- por unidad capturada
  lote            text
);

-- p: {almacen_id, proveedor_id, documento_proveedor, comentarios, idempotency_key,
--     partidas:[{producto_id, unidad_venta_id, cantidad, costo_unitario, lote}]}
create or replace function public.registrar_entrada(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_almacen almacenes%rowtype; v_id uuid; v_serie text; v_folio bigint;
  r record; v_antes numeric; v_costo_base numeric; v_cant_base numeric;
  v_prod productos%rowtype; v_existente uuid; v_pend record; v_usar numeric; v_restante numeric;
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

  perform bloquear_existencias((select jsonb_agg(jsonb_build_object('producto_id', x->>'producto_id', 'almacen_id', v_almacen.id))
                                  from jsonb_array_elements(p->'partidas') x));

  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_almacen.sucursal_id, 'entrada') s;
  insert into entradas (sucursal_id, almacen_id, proveedor_id, serie, folio, documento_proveedor, usuario_id, comentarios, idempotency_key)
  values (v_almacen.sucursal_id, v_almacen.id, nullif(p->>'proveedor_id','')::uuid, v_serie, v_folio,
          p->>'documento_proveedor', auth.uid(), p->>'comentarios', p->>'idempotency_key')
  returning id into v_id;

  for r in
    select (x->>'producto_id')::uuid producto_id, (x->>'unidad_venta_id')::uuid unidad_venta_id,
           (x->>'cantidad')::numeric cantidad, (x->>'costo_unitario')::numeric costo_unitario, x->>'lote' lote,
           u.factor, u.producto_id as u_producto
      from jsonb_array_elements(p->'partidas') x
      join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
  loop
    perform exigir(r.u_producto = r.producto_id, 'La unidad no corresponde al producto');
    perform exigir(r.cantidad > 0 and r.costo_unitario >= 0, 'Cantidad o costo inválido');
    v_cant_base := round(r.cantidad * r.factor, 6);
    v_costo_base := round(r.costo_unitario / r.factor, 6);

    insert into entrada_partidas (entrada_id, producto_id, unidad_venta_id, cantidad, factor, cantidad_base, costo_unitario, lote)
    values (v_id, r.producto_id, r.unidad_venta_id, r.cantidad, r.factor, v_cant_base, r.costo_unitario, r.lote);

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

  return jsonb_build_object('entrada_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

-- ---------------------------------------------------------------------
-- Traspasos: enviado -> en_transito -> recibido (o cancelado antes de recibir)
-- ---------------------------------------------------------------------
create table public.traspasos (
  id               uuid primary key default gen_random_uuid(),
  sucursal_id      uuid not null references public.sucursales(id),
  almacen_origen   uuid not null references public.almacenes(id),
  almacen_destino  uuid not null references public.almacenes(id),
  serie            text not null,
  folio            bigint not null,
  estado           text not null default 'enviado' check (estado in ('enviado','en_transito','recibido','cancelado')),
  enviado_por      uuid, enviado_en timestamptz not null default now(),
  recibido_por     uuid, recibido_en timestamptz,
  comentarios      text,
  idempotency_key  text unique,
  check (almacen_origen <> almacen_destino),
  unique (sucursal_id, serie, folio)
);

create table public.traspaso_partidas (
  id              uuid primary key default gen_random_uuid(),
  traspaso_id     uuid not null references public.traspasos(id),
  producto_id     uuid not null references public.productos(id),
  unidad_venta_id uuid not null references public.unidades_venta(id),
  cantidad        numeric(18,6) not null check (cantidad > 0),
  factor          numeric(18,8) not null,
  cantidad_base   numeric(18,6) not null,
  cantidad_recibida_base numeric(18,6)
);

create or replace function public.enviar_traspaso(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_or almacenes%rowtype; v_id uuid; v_serie text; v_folio bigint; r record; v_cb numeric; v_ex uuid;
begin
  select id into v_ex from traspasos where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('traspaso_id', v_ex, 'repetida', true); end if;

  select * into v_or from almacenes where id = (p->>'almacen_origen')::uuid;
  perform exigir(v_or.id is not null, 'Almacén origen no encontrado');
  perform exigir(opera_almacen(v_or.id), 'No puedes enviar traspasos desde este almacén');
  perform exigir(tiene_permiso('traspasar'), 'No tienes permiso para traspasar');
  perform exigir(exists(select 1 from almacenes where id = (p->>'almacen_destino')::uuid and activo), 'Almacén destino no válido');

  perform bloquear_existencias((select jsonb_agg(jsonb_build_object('producto_id', x->>'producto_id', 'almacen_id', v_or.id))
                                  from jsonb_array_elements(p->'partidas') x));
  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_or.sucursal_id, 'traspaso') s;
  insert into traspasos (sucursal_id, almacen_origen, almacen_destino, serie, folio, enviado_por, comentarios, idempotency_key)
  values (v_or.sucursal_id, v_or.id, (p->>'almacen_destino')::uuid, v_serie, v_folio, auth.uid(), p->>'comentarios', p->>'idempotency_key')
  returning id into v_id;

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'unidad_venta_id')::uuid unidad_venta_id,
                  (x->>'cantidad')::numeric cantidad, u.factor, u.producto_id u_producto
             from jsonb_array_elements(p->'partidas') x join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
  loop
    perform exigir(r.u_producto = r.producto_id and r.cantidad > 0, 'Partida de traspaso inválida');
    v_cb := round(r.cantidad * r.factor, 6);
    insert into traspaso_partidas (traspaso_id, producto_id, unidad_venta_id, cantidad, factor, cantidad_base)
    values (v_id, r.producto_id, r.unidad_venta_id, r.cantidad, r.factor, v_cb);
    perform mover_inventario(r.producto_id, v_or.id, -v_cb, 'traspaso_salida', 'traspaso', v_id, costo_venta(r.producto_id));
  end loop;
  return jsonb_build_object('traspaso_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;

create or replace function public.marcar_traspaso_en_transito(p_traspaso uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t traspasos%rowtype;
begin
  select * into t from traspasos where id = p_traspaso for update;
  perform exigir(t.id is not null, 'Traspaso no encontrado');
  perform exigir(opera_almacen(t.almacen_origen), 'No puedes modificar este traspaso');
  perform exigir(t.estado = 'enviado', 'Solo un traspaso enviado puede pasar a en tránsito');
  update traspasos set estado = 'en_transito' where id = p_traspaso;
end $$;

-- p: {traspaso_id, partidas:[{partida_id, cantidad_recibida_base}]?}  (sin partidas = todo completo)
create or replace function public.recibir_traspaso(p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare t traspasos%rowtype; r record; v_rec numeric;
begin
  select * into t from traspasos where id = (p->>'traspaso_id')::uuid for update;
  perform exigir(t.id is not null, 'Traspaso no encontrado');
  perform exigir(opera_almacen(t.almacen_destino), 'No puedes recibir en el almacén destino');
  perform exigir(tiene_permiso('traspasar'), 'No tienes permiso para traspasar');
  perform exigir(t.estado in ('enviado','en_transito'), 'El traspaso ya fue recibido o cancelado');

  perform bloquear_existencias((select jsonb_agg(jsonb_build_object('producto_id', producto_id, 'almacen_id', t.almacen_destino))
                                  from traspaso_partidas where traspaso_id = t.id));
  for r in select * from traspaso_partidas where traspaso_id = t.id loop
    v_rec := coalesce((select (x->>'cantidad_recibida_base')::numeric from jsonb_array_elements(p->'partidas') x
                        where (x->>'partida_id')::uuid = r.id), r.cantidad_base);
    perform exigir(v_rec >= 0 and v_rec <= r.cantidad_base, 'No se puede recibir más de lo enviado');
    update traspaso_partidas set cantidad_recibida_base = v_rec where id = r.id;
    if v_rec > 0 then
      perform mover_inventario(r.producto_id, t.almacen_destino, v_rec, 'traspaso_entrada', 'traspaso', t.id, costo_venta(r.producto_id));
    end if;
    -- Diferencias (faltante en tránsito) quedan registradas para autorización: pendiente P18
  end loop;
  update traspasos set estado = 'recibido', recibido_por = auth.uid(), recibido_en = now() where id = t.id;
end $$;

create or replace function public.cancelar_traspaso(p_traspaso uuid, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare t traspasos%rowtype; r record;
begin
  select * into t from traspasos where id = p_traspaso for update;
  perform exigir(t.id is not null, 'Traspaso no encontrado');
  perform exigir(opera_almacen(t.almacen_origen), 'No puedes cancelar este traspaso');
  perform exigir(t.estado in ('enviado','en_transito'), 'Solo se cancela un traspaso no recibido');
  for r in select * from traspaso_partidas where traspaso_id = t.id order by producto_id loop
    perform mover_inventario(r.producto_id, t.almacen_origen, r.cantidad_base, 'cancelacion_traspaso', 'traspaso', t.id,
                             costo_venta(r.producto_id), p_motivo);
  end loop;
  update traspasos set estado = 'cancelado' where id = t.id;
  perform registrar_bitacora('cancelar', 'traspasos', t.id::text, to_jsonb(t), jsonb_build_object('motivo', p_motivo));
end $$;

-- ---------------------------------------------------------------------
-- Ajustes de inventario (con permiso y motivo obligatorio)
-- ---------------------------------------------------------------------
create table public.ajustes (
  id          uuid primary key default gen_random_uuid(),
  sucursal_id uuid not null references public.sucursales(id),
  almacen_id  uuid not null references public.almacenes(id),
  serie       text not null,
  folio       bigint not null,
  motivo      text not null check (length(trim(motivo)) > 0),
  origen      text not null default 'manual' check (origen in ('manual','conteo','inventario_inicial','hoja_calculo')),
  usuario_id  uuid,
  fecha       timestamptz not null default now(),
  idempotency_key text unique,
  unique (sucursal_id, serie, folio)
);

create table public.ajuste_partidas (
  id            uuid primary key default gen_random_uuid(),
  ajuste_id     uuid not null references public.ajustes(id),
  producto_id   uuid not null references public.productos(id),
  cantidad_base numeric(18,6) not null check (cantidad_base <> 0)
);

-- p: {almacen_id, motivo, origen, idempotency_key, partidas:[{producto_id, unidad_venta_id, cantidad}]}  cantidad con signo
create or replace function public.registrar_ajuste(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_al almacenes%rowtype; v_id uuid; v_serie text; v_folio bigint; r record; v_cb numeric; v_ex uuid;
        v_origen text := coalesce(p->>'origen','manual');
begin
  select id into v_ex from ajustes where idempotency_key = p->>'idempotency_key';
  if v_ex is not null then return jsonb_build_object('ajuste_id', v_ex, 'repetida', true); end if;

  select * into v_al from almacenes where id = (p->>'almacen_id')::uuid;
  perform exigir(v_al.id is not null, 'Almacén no encontrado');
  perform exigir(opera_almacen(v_al.id), 'No puedes ajustar este almacén');
  perform exigir(tiene_permiso('ajustar_inventario'), 'No tienes permiso para ajustar inventario');
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'El motivo es obligatorio');

  perform bloquear_existencias((select jsonb_agg(jsonb_build_object('producto_id', x->>'producto_id', 'almacen_id', v_al.id))
                                  from jsonb_array_elements(p->'partidas') x));
  select s.serie, s.folio into v_serie, v_folio from siguiente_folio(v_al.sucursal_id, 'ajuste') s;
  insert into ajustes (sucursal_id, almacen_id, serie, folio, motivo, origen, usuario_id, idempotency_key)
  values (v_al.sucursal_id, v_al.id, v_serie, v_folio, p->>'motivo', v_origen, auth.uid(), p->>'idempotency_key')
  returning id into v_id;

  for r in select (x->>'producto_id')::uuid producto_id, (x->>'cantidad')::numeric cantidad, u.factor, u.producto_id u_producto
             from jsonb_array_elements(p->'partidas') x join unidades_venta u on u.id = (x->>'unidad_venta_id')::uuid
  loop
    perform exigir(r.u_producto = r.producto_id, 'La unidad no corresponde al producto');
    v_cb := round(r.cantidad * r.factor, 6);
    continue when v_cb = 0;
    insert into ajuste_partidas (ajuste_id, producto_id, cantidad_base) values (v_id, r.producto_id, v_cb);
    perform mover_inventario(r.producto_id, v_al.id, v_cb,
      case when v_origen = 'inventario_inicial' then 'inventario_inicial' else 'ajuste' end,
      'ajuste', v_id, costo_venta(r.producto_id), p->>'motivo');
  end loop;
  perform registrar_bitacora('ajustar', 'ajustes', v_id::text, null, p);
  return jsonb_build_object('ajuste_id', v_id, 'serie', v_serie, 'folio', v_folio, 'repetida', false);
end $$;
