-- =============================================================================
-- Pago de un cliente repartido entre sus notas con saldo (de la más antigua a la más nueva).
-- p = {idempotency_key, cliente_id, forma, importe, referencia?, comentarios?, ventas?: [venta_id,...]}
--   ventas: si se indican, solo esas (en ese orden de antigüedad); si no, todas las que el usuario puede cobrar.
-- Todo o nada: si algo falla no se registra ningún pago. Cada nota recibe su propio pago (entra al corte
-- de su sucursal con la fecha de hoy). Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.registrar_pago_cliente(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_key text := p->>'idempotency_key'; v_imp numeric := round(nullif(p->>'importe','')::numeric, 2);
  v_forma text := p->>'forma'; v_cli uuid := nullif(p->>'cliente_id','')::uuid;
  v_resta numeric; v_apl numeric; v ventas%rowtype; v_n int := 0; v_det jsonb := '[]'; v_total_saldo numeric;
  v_sel uuid[] := (select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'ventas', '[]')) x);
begin
  perform exigir(length(coalesce(v_key,'')) >= 8, 'Falta la clave de idempotencia');
  perform pg_advisory_xact_lock(hashtextextended('pagocli:' || v_key, 0));
  if exists (select 1 from venta_pagos where idempotency_key like v_key || ':%') then
    return jsonb_build_object('repetida', true, 'aplicado', (select jsonb_agg(jsonb_build_object('venta_id', venta_id, 'importe', importe))
                                                              from venta_pagos where idempotency_key like v_key || ':%'));
  end if;
  perform exigir(v_cli is not null and exists (select 1 from clientes where id = v_cli and not es_publico_general), 'Elige un cliente registrado');
  perform exigir(v_forma in ('efectivo','transferencia','tarjeta_debito','tarjeta_credito'), 'Forma de pago no válida');
  perform exigir(v_imp is not null and v_imp > 0, 'El importe debe ser mayor a cero');

  select coalesce(sum(saldo), 0) into v_total_saldo from ventas
   where cliente_id = v_cli and estado = 'confirmada' and saldo > 0 and opera_sucursal(sucursal_id)
     and (v_sel is null or id = any(v_sel));
  perform exigir(v_total_saldo > 0, 'El cliente no tiene notas con saldo que puedas cobrar');
  perform exigir(v_imp <= v_total_saldo, format('El pago excede lo que debe en esas notas (%s)', v_total_saldo));

  v_resta := v_imp;
  for v in select * from ventas
            where cliente_id = v_cli and estado = 'confirmada' and saldo > 0 and opera_sucursal(sucursal_id)
              and (v_sel is null or id = any(v_sel))
            order by coalesce(vencimiento, fecha::date), fecha
            for update loop
    exit when v_resta <= 0;
    v_apl := least(v.saldo, v_resta);
    v_n := v_n + 1;
    insert into venta_pagos (venta_id, forma, importe, referencia, usuario_id, comentarios, idempotency_key)
    values (v.id, v_forma, v_apl, nullif(trim(p->>'referencia'),''), auth.uid(), nullif(trim(p->>'comentarios'),''), v_key || ':' || v_n);
    update ventas set pagado = pagado + v_apl, saldo = saldo - v_apl where id = v.id;
    perform registrar_bitacora('pago', 'ventas', v.id::text, jsonb_build_object('saldo', v.saldo),
                               jsonb_build_object('forma', v_forma, 'importe', v_apl, 'pago_de_cliente', v_key));
    v_det := v_det || jsonb_build_object('venta_id', v.id, 'serie', v.serie, 'folio', v.folio, 'importe', v_apl, 'saldo', v.saldo - v_apl);
    v_resta := v_resta - v_apl;
  end loop;
  return jsonb_build_object('repetida', false, 'aplicado', v_det);
end $$;

revoke execute on function public.registrar_pago_cliente(jsonb) from public, anon;
grant execute on function public.registrar_pago_cliente(jsonb) to authenticated;
