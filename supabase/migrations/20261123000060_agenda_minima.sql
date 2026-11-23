-- =============================================================================
-- Agenda: para agendar basta el día y el destino (las notas y lo que se lleva son opcionales).
-- Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.guardar_envio(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id uuid := nullif(p->>'id','')::uuid; v_antes envios%rowtype; v_cli uuid := nullif(p->>'cliente_id','')::uuid; v_ex uuid;
begin
  perform exigir(exists (select 1 from perfiles where user_id = auth.uid() and activo), 'Usuario no autorizado');
  perform exigir(not es_contabilidad(), 'Tu usuario es de solo consulta');
  perform exigir(nullif(p->>'fecha','') is not null, 'Indica el día del envío');
  perform exigir(length(trim(coalesce(p->>'destino',''))) > 0, 'Indica el destino');
  perform exigir(coalesce(p->>'prioridad','normal') in ('baja','normal','alta','urgente'), 'Prioridad no válida');
  -- el cliente, si no se indica, es el de la primera nota (si no es Público en general)
  if v_cli is null then
    select v.cliente_id into v_cli from ventas v join clientes c on c.id = v.cliente_id
     where v.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ventas','[]')) x) and not c.es_publico_general limit 1;
  end if;

  if v_id is null then
    select id into v_ex from envios where idempotency_key = p->>'idempotency_key';
    if v_ex is not null then return jsonb_build_object('envio_id', v_ex, 'repetida', true); end if;
    insert into envios (sucursal_id, cliente_id, fecha, hora, destino, direccion, contacto, telefono, prioridad, chofer, vehiculo, contenido, notas, idempotency_key)
    values (nullif(p->>'sucursal_id','')::uuid, v_cli, (p->>'fecha')::date, nullif(trim(p->>'hora'),''), trim(p->>'destino'), nullif(trim(p->>'direccion'),''),
            nullif(trim(p->>'contacto'),''), nullif(trim(p->>'telefono'),''), coalesce(p->>'prioridad','normal'), nullif(trim(p->>'chofer'),''),
            nullif(trim(p->>'vehiculo'),''), nullif(trim(p->>'contenido'),''), nullif(trim(p->>'notas'),''), p->>'idempotency_key')
    returning id into v_id;
    perform registrar_bitacora('crear', 'envios', v_id::text, null, p);
  else
    select * into v_antes from envios where id = v_id for update;
    perform exigir(v_antes.id is not null, 'Envío no encontrado');
    perform exigir(v_antes.estado in ('programado','en_ruta'), 'Un envío ' || v_antes.estado || ' ya no se edita');
    update envios set sucursal_id = nullif(p->>'sucursal_id','')::uuid, cliente_id = v_cli, fecha = (p->>'fecha')::date, hora = nullif(trim(p->>'hora'),''),
           destino = trim(p->>'destino'), direccion = nullif(trim(p->>'direccion'),''), contacto = nullif(trim(p->>'contacto'),''),
           telefono = nullif(trim(p->>'telefono'),''), prioridad = coalesce(p->>'prioridad','normal'), chofer = nullif(trim(p->>'chofer'),''),
           vehiculo = nullif(trim(p->>'vehiculo'),''), contenido = nullif(trim(p->>'contenido'),''), notas = nullif(trim(p->>'notas'),''),
           actualizado_por = auth.uid(), actualizado_en = now()
     where id = v_id;
    delete from envio_ventas where envio_id = v_id;
    perform registrar_bitacora('editar', 'envios', v_id::text, to_jsonb(v_antes), p);
  end if;

  insert into envio_ventas (envio_id, venta_id)
  select v_id, v.id from ventas v where v.id in (select (x)::uuid from jsonb_array_elements_text(coalesce(p->'ventas','[]')) x)
  on conflict do nothing;
  return jsonb_build_object('envio_id', v_id, 'numero', (select numero from envios where id = v_id), 'repetida', false);
end $$;

revoke execute on function public.guardar_envio(jsonb) from public, anon;
grant execute on function public.guardar_envio(jsonb) to authenticated;
