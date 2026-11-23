-- =============================================================================
-- Devolución de producto de una nota que todavía debe: primero se descuenta de su saldo pendiente
-- y solo el resto se devuelve en dinero o queda como saldo a favor (antes el saldo no bajaba).
-- devoluciones_producto.aplicado_saldo guarda lo descontado; destino 'saldo_nota' = todo se descontó.
-- Se puede ejecutar más de una vez.
-- =============================================================================
begin;

alter table public.devoluciones_producto add column if not exists aplicado_saldo numeric(14,2) not null default 0;
alter table public.devoluciones_producto drop constraint if exists devoluciones_producto_destino_check;
alter table public.devoluciones_producto add constraint devoluciones_producto_destino_check check (destino in ('saldo_favor', 'dinero', 'saldo_nota'));

create or replace function public.devolver_productos(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v ventas%rowtype; v_cli clientes%rowtype; x jsonb; vp venta_partidas%rowtype; pr productos%rowtype;
  v_cant numeric; v_cb numeric; v_imp numeric := 0; v_i numeric; v_det jsonb := '[]'; v_id uuid;
  v_dest clientes%rowtype; v_resta numeric; v_tarjeta numeric; v_otro numeric; v_ya numeric;
  v_aplica numeric := 0; v_rest numeric;
begin
  perform exigir(length(coalesce(p->>'idempotency_key','')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('devolucion:' || (p->>'idempotency_key'), 0));
  select id into v_id from devoluciones_producto where idempotency_key = p->>'idempotency_key';
  if v_id is not null then return jsonb_build_object('devolucion_id', v_id, 'repetida', true); end if;

  select * into v from ventas where id = (p->>'venta_id')::uuid for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes registrar devoluciones de esta sucursal');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');
  perform exigir(length(trim(coalesce(p->>'motivo',''))) > 0, 'Indica el motivo de la devolución');
  perform exigir(p->>'destino' in ('saldo_favor', 'dinero'), 'Indica si el importe queda a favor o se devuelve');
  select * into v_cli from clientes where id = v.cliente_id;
  v_dest := v_cli;
  if p->>'destino' = 'saldo_favor' and v_cli.es_publico_general and v.saldo = 0 then
    select * into v_dest from clientes where id = nullif(p->>'cliente_id','')::uuid;
    perform exigir(v_dest.id is not null and v_dest.activo and not v_dest.es_publico_general,
                   'La venta es de Público en general: elige o da de alta al cliente que recibe el saldo a favor');
  end if;
  perform exigir(v.saldo > 0 or p->>'destino' = 'saldo_favor' or p->>'forma' in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Indica cómo se devuelve el dinero');

  for x in select * from jsonb_array_elements(coalesce(p->'partidas', '[]')) loop
    v_cant := nullif(x->>'cantidad','')::numeric;
    continue when v_cant is null or v_cant = 0;
    select * into vp from venta_partidas where id = (x->>'partida_id')::uuid and venta_id = v.id for update;
    perform exigir(vp.id is not null, 'Renglón no encontrado en la venta');
    select * into pr from productos where id = vp.producto_id;
    perform exigir(v_cant > 0, pr.nombre || ': cantidad no válida');
    v_resta := vp.cantidad_entregada - vp.cantidad_devuelta;
    if abs(v_cant - v_resta) < 0.00001 then v_cant := v_resta; end if;
    perform exigir(v_cant <= vp.cantidad_entregada - vp.cantidad_devuelta,
                   format('%s: solo puedes devolver lo entregado y no devuelto (%s %s)', pr.nombre, vp.cantidad_entregada - vp.cantidad_devuelta, vp.unidad_nombre));
    v_cb := cantidad_base_de(v_cant, vp.factor, pr.permite_fraccion, pr.nombre);
    v_i := round(vp.total * v_cant / vp.cantidad, 2);
    if pr.tipo = 'producto' then
      perform bloquear_existencias(jsonb_build_array(jsonb_build_object('producto_id', pr.id, 'almacen_id', coalesce(vp.almacen_id, v.almacen_id))));
      perform mover_inventario(pr.id, coalesce(vp.almacen_id, v.almacen_id), v_cb, 'devolucion', 'venta', v.id, vp.costo_unitario_base,
                               'Devolución: ' || trim(p->>'motivo'));
    end if;
    update venta_partidas set cantidad_devuelta = cantidad_devuelta + v_cant where id = vp.id;
    v_imp := v_imp + v_i;
    v_det := v_det || jsonb_build_object('partida_id', vp.id, 'producto', pr.nombre, 'unidad', vp.unidad_nombre, 'cantidad', v_cant, 'importe', v_i);
  end loop;
  perform exigir(v_imp > 0, 'Indica qué productos y cuántos se devuelven');

  -- Primero se descuenta de lo que la nota todavía debe; solo el resto se devuelve o queda a favor
  v_aplica := least(v.saldo, v_imp);
  v_rest := v_imp - v_aplica;
  if v_aplica > 0 then update ventas set saldo = saldo - v_aplica where id = v.id; end if;
  if v_rest > 0 and p->>'destino' = 'saldo_favor' and v_cli.es_publico_general and v_dest.id = v_cli.id then
    select * into v_dest from clientes where id = nullif(p->>'cliente_id','')::uuid;
    perform exigir(v_dest.id is not null and v_dest.activo and not v_dest.es_publico_general,
                   'La venta es de Público en general: elige o da de alta al cliente que recibe el saldo a favor');
  end if;
  if v_rest > 0 then
    perform exigir(p->>'destino' = 'saldo_favor' or p->>'forma' in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Indica cómo se devuelve el dinero');
  end if;

  if v_rest > 0 and p->>'destino' = 'dinero' and p->>'forma' in ('efectivo', 'transferencia') then
    select coalesce(sum(importe) filter (where forma in ('tarjeta_debito','tarjeta_credito')), 0),
           coalesce(sum(importe) filter (where forma in ('efectivo','transferencia')), 0)
      into v_tarjeta, v_otro from venta_pagos where venta_id = v.id;
    select coalesce(sum(importe), 0) into v_ya from venta_devoluciones
     where venta_id = v.id and forma in ('efectivo','transferencia');
    if v_tarjeta > 0 and v_rest > greatest(v_otro - v_ya, 0) and not tiene_permiso('devolver_efectivo') then
      raise exception using errcode = 'P0001', message = format(
        'Esta venta se pagó con tarjeta: no se puede devolver en %s%s. Déjalo como saldo a favor o contacta a matriz para que autoricen y registren la devolución.',
        case when p->>'forma' = 'efectivo' then 'efectivo' else 'transferencia' end,
        case when v_otro - v_ya > 0 then format(' más de %s', to_char(v_otro - v_ya, 'FM$999,999,990.00')) else '' end);
    end if;
  end if;

  if v_rest > 0 and p->>'destino' = 'saldo_favor' then
    perform mover_saldo_favor(v_dest.id, v_rest, v.id, format('Devolución de productos de la venta %s %s', v.serie, v.folio));
  elsif v_rest > 0 then
    insert into venta_devoluciones (venta_id, forma, importe, motivo, usuario_id) values (v.id, p->>'forma', v_rest, 'Devolución de productos', auth.uid());
  end if;
  insert into devoluciones_producto (venta_id, usuario_id, destino, forma, importe, motivo, partidas, idempotency_key, cliente_id, aplicado_saldo)
  values (v.id, auth.uid(), case when v_rest > 0 then p->>'destino' else 'saldo_nota' end,
          case when v_rest > 0 and p->>'destino' = 'dinero' then p->>'forma' end, v_imp, trim(p->>'motivo'), v_det, p->>'idempotency_key',
          case when v_rest > 0 and p->>'destino' = 'saldo_favor' then v_dest.id end, v_aplica)
  returning id into v_id;
  -- La venta queda cerrada: ya no se edita (el material devuelto ya regresó al inventario)
  update ventas set cerrada = true, cerrada_en = coalesce(cerrada_en, now()), cerrada_por = coalesce(cerrada_por, auth.uid()) where id = v.id;
  perform registrar_bitacora('devolucion', 'ventas', v.id::text, null,
                             jsonb_build_object('importe', v_imp, 'aplicado_saldo', v_aplica, 'destino', p->>'destino', 'forma', p->>'forma', 'motivo', p->>'motivo', 'partidas', v_det,
                                                'cliente_saldo', case when v_dest.id is distinct from v_cli.id then v_dest.nombre end));
  return jsonb_build_object('devolucion_id', v_id, 'importe', v_imp, 'aplicado_saldo', v_aplica, 'devuelto', v_rest, 'repetida', false);
end $$;

revoke execute on function public.devolver_productos(jsonb) from public, anon;
grant execute on function public.devolver_productos(jsonb) to authenticated;

commit;
