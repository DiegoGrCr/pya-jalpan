-- =====================================================================
-- 0005 · Seguridad (RLS)
-- Principios:
--   * Todos los usuarios autenticados CONSULTAN catálogos y existencias de todas las sucursales.
--   * Las operaciones (ventas, cotizaciones, inventario) se escriben SOLO mediante funciones
--     SECURITY DEFINER que validan permiso y sucursal. No hay políticas de INSERT/UPDATE/DELETE
--     directas para usuarios en tablas transaccionales.
--   * Los documentos transaccionales se leen solo en las sucursales del usuario (o admin).
--   * Los costos se ocultan con vistas para quien no tiene 'ver_costos' (capa de API).
-- =====================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'empresa','sucursales','almacenes','cajas','series','perfiles','usuario_sucursales','permisos','rol_permisos',
    'usuario_permisos','bitacora','sat_catalogo','categorias','marcas','productos','unidades_venta','listas_precios',
    'precios','producto_almacen','proveedores','clientes','existencias','movimientos','costo_pendiente',
    'ajustes_costo_venta','entradas','entrada_partidas','traspasos','traspaso_partidas','ajustes','ajuste_partidas',
    'cotizaciones','cotizacion_partidas','ventas','venta_partidas','venta_pagos','entregas','entrega_partidas']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- ---------- Lectura general (todos los autenticados) ----------
do $$
declare t text;
begin
  foreach t in array array['empresa','sucursales','almacenes','cajas','permisos','rol_permisos','sat_catalogo',
    'categorias','marcas','productos','unidades_venta','listas_precios','precios','producto_almacen',
    'proveedores','clientes','existencias']
  loop
    execute format('create policy lectura_general on public.%I for select to authenticated using (true)', t);
  end loop;
end $$;

-- ---------- Administración de catálogos: solo con permiso 'administrar' ----------
do $$
declare t text;
begin
  foreach t in array array['sucursales','almacenes','cajas','series','categorias','marcas','productos',
    'unidades_venta','listas_precios','precios','producto_almacen','proveedores','sat_catalogo',
    'perfiles','usuario_sucursales','usuario_permisos','empresa']
  loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
    execute format($p$create policy administrar_ins on public.%I for insert to authenticated with check (public.tiene_permiso('administrar'))$p$, t);
    execute format($p$create policy administrar_upd on public.%I for update to authenticated using (public.tiene_permiso('administrar')) with check (public.tiene_permiso('administrar'))$p$, t);
    execute format($p$create policy administrar_del on public.%I for delete to authenticated using (public.tiene_permiso('administrar'))$p$, t);
  end loop;
end $$;

-- Clientes: cualquier usuario activo puede darlos de alta y editar datos de contacto/fiscales;
-- los campos de crédito se protegen con trigger.
grant insert, update on public.clientes to authenticated;
create policy clientes_ins on public.clientes for insert to authenticated
  with check (exists (select 1 from public.perfiles where user_id = auth.uid() and activo));
create policy clientes_upd on public.clientes for update to authenticated
  using (exists (select 1 from public.perfiles where user_id = auth.uid() and activo))
  with check (exists (select 1 from public.perfiles where user_id = auth.uid() and activo));

create or replace function public.trg_clientes_credito()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and (new.limite_credito > 0 or new.dias_credito > 0))
     or (tg_op = 'UPDATE' and (new.limite_credito, new.dias_credito, new.bloqueado)
                         is distinct from (old.limite_credito, old.dias_credito, old.bloqueado)) then
    if not public.tiene_permiso('otorgar_credito') and current_user = 'authenticated' then
      raise exception 'No tienes permiso para modificar el crédito del cliente';
    end if;
  end if;
  if tg_op = 'UPDATE' and old.es_publico_general and current_user = 'authenticated'
     and not public.tiene_permiso('administrar') then
    raise exception 'El cliente Público en general no se modifica';
  end if;
  return new;
end $$;
create trigger clientes_credito before insert or update on public.clientes
  for each row execute function public.trg_clientes_credito();

-- ---------- Perfiles y permisos: cada quien ve el suyo; admin ve todos ----------
create policy perfiles_sel on public.perfiles for select to authenticated
  using (user_id = auth.uid() or public.tiene_permiso('administrar'));
create policy usuario_sucursales_sel on public.usuario_sucursales for select to authenticated
  using (user_id = auth.uid() or public.tiene_permiso('administrar'));
create policy usuario_permisos_sel on public.usuario_permisos for select to authenticated
  using (user_id = auth.uid() or public.tiene_permiso('administrar'));
create policy series_sel on public.series for select to authenticated using (true);
create policy bitacora_sel on public.bitacora for select to authenticated using (public.tiene_permiso('administrar'));

-- ---------- Kardex: todos consultan (existencias son públicas internamente) ----------
create policy movimientos_sel on public.movimientos for select to authenticated using (true);

-- ---------- Documentos: solo sucursales propias ----------
create policy cotizaciones_sel on public.cotizaciones for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy cotizacion_partidas_sel on public.cotizacion_partidas for select to authenticated
  using (exists (select 1 from public.cotizaciones c where c.id = cotizacion_id and public.opera_sucursal(c.sucursal_id)));
create policy ventas_sel on public.ventas for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy venta_partidas_sel on public.venta_partidas for select to authenticated
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.opera_sucursal(v.sucursal_id)));
create policy venta_pagos_sel on public.venta_pagos for select to authenticated
  using (exists (select 1 from public.ventas v where v.id = venta_id and public.opera_sucursal(v.sucursal_id)));
create policy entregas_sel on public.entregas for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy entrega_partidas_sel on public.entrega_partidas for select to authenticated
  using (exists (select 1 from public.entregas e where e.id = entrega_id and public.opera_sucursal(e.sucursal_id)));
create policy entradas_sel on public.entradas for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy entrada_partidas_sel on public.entrada_partidas for select to authenticated
  using (exists (select 1 from public.entradas e where e.id = entrada_id and public.opera_sucursal(e.sucursal_id)));
create policy traspasos_sel on public.traspasos for select to authenticated
  using (public.opera_almacen(almacen_origen) or public.opera_almacen(almacen_destino));
create policy traspaso_partidas_sel on public.traspaso_partidas for select to authenticated
  using (exists (select 1 from public.traspasos t where t.id = traspaso_id
                 and (public.opera_almacen(t.almacen_origen) or public.opera_almacen(t.almacen_destino))));
create policy ajustes_sel on public.ajustes for select to authenticated using (public.opera_sucursal(sucursal_id));
create policy ajuste_partidas_sel on public.ajuste_partidas for select to authenticated
  using (exists (select 1 from public.ajustes a where a.id = ajuste_id and public.opera_sucursal(a.sucursal_id)));
create policy costo_pendiente_sel on public.costo_pendiente for select to authenticated using (public.tiene_permiso('ver_costos'));
create policy ajustes_costo_sel on public.ajustes_costo_venta for select to authenticated using (public.tiene_permiso('ver_costos'));

-- ---------- Funciones: internas sin acceso; RPC públicas solo para autenticados ----------
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.es_admin(), public.tiene_permiso(text), public.opera_sucursal(uuid), public.opera_almacen(uuid),
  public.confirmar_venta(jsonb), public.cancelar_venta(uuid, text), public.registrar_entrega(jsonb),
  public.guardar_cotizacion(jsonb), public.cambiar_estado_cotizacion(uuid, text), public.preparar_conversion(uuid),
  public.calcular_unidades(uuid, numeric), public.calcular_partida(numeric, numeric, numeric, numeric, numeric, boolean),
  public.registrar_entrada(jsonb), public.enviar_traspaso(jsonb), public.marcar_traspaso_en_transito(uuid),
  public.recibir_traspaso(jsonb), public.cancelar_traspaso(uuid, text), public.registrar_ajuste(jsonb),
  public.saldo_cliente(uuid), public.lista_efectiva(uuid, uuid), public.costo_venta(uuid), public.exigir(boolean, text)
to authenticated;
grant select on public.v_cotizaciones, public.v_pendiente_entrega to authenticated;
