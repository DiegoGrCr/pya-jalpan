-- =============================================================================
-- 0023 · Registrar pago (abono) a una venta con saldo pendiente
-- Para ventas a crédito o que quedaron con saldo: se registra la forma de pago, el importe
-- (hasta el saldo), referencia y comentarios. El pago queda con fecha y usuario para el corte.
-- Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.venta_pagos add column if not exists usuario_id      uuid;
alter table public.venta_pagos add column if not exists comentarios     text;
alter table public.venta_pagos add column if not exists idempotency_key text unique;

-- p: {idempotency_key, venta_id, forma, importe, referencia?, comentarios?}
create or replace function public.registrar_pago_venta(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v ventas%rowtype; v_key text := p->>'idempotency_key'; v_ex venta_pagos%rowtype;
  v_imp numeric := round(nullif(p->>'importe','')::numeric, 2);
  v_forma text := p->>'forma'; v_id uuid;
begin
  perform exigir(length(coalesce(v_key,'')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('pago:' || v_key, 0));
  select * into v_ex from venta_pagos where idempotency_key = v_key;
  if v_ex.id is not null then
    select * into v from ventas where id = v_ex.venta_id;
    return jsonb_build_object('pago_id', v_ex.id, 'saldo', v.saldo, 'repetida', true);
  end if;

  select * into v from ventas where id = (p->>'venta_id')::uuid for update;
  perform exigir(v.id is not null, 'Venta no encontrada');
  perform exigir(opera_sucursal(v.sucursal_id), 'No puedes registrar pagos de esta sucursal');
  perform exigir(v.estado = 'confirmada', 'La venta está cancelada');
  perform exigir(v.saldo > 0, 'La venta no tiene saldo pendiente');
  perform exigir(v_forma in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Forma de pago no válida');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');
  perform exigir(v_imp <= v.saldo, format('El importe excede el saldo pendiente (%s)', v.saldo));

  insert into venta_pagos (venta_id, forma, importe, referencia, usuario_id, comentarios, idempotency_key)
  values (v.id, v_forma, v_imp, nullif(trim(p->>'referencia'),''), auth.uid(), nullif(trim(p->>'comentarios'),''), v_key)
  returning id into v_id;
  update ventas set pagado = pagado + v_imp, saldo = saldo - v_imp where id = v.id;

  perform registrar_bitacora('pago', 'ventas', v.id::text, jsonb_build_object('saldo', v.saldo),
                             jsonb_build_object('pago_id', v_id, 'forma', v_forma, 'importe', v_imp));
  return jsonb_build_object('pago_id', v_id, 'saldo', v.saldo - v_imp, 'repetida', false);
end $$;

revoke execute on function public.registrar_pago_venta(jsonb) from public, anon;
grant execute on function public.registrar_pago_venta(jsonb) to authenticated;
