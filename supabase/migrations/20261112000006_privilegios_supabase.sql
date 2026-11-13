-- =====================================================================
-- 0006 · Endurecimiento de privilegios para Supabase
-- Supabase concede por defecto ALL en tablas y EXECUTE en funciones nuevas a
-- anon y authenticated. Eso dejaba ejecutables funciones internas
-- (p. ej. mover_inventario) y permitía TRUNCATE (que RLS no cubre).
-- Esta migración deja privilegios mínimos explícitos.
-- =====================================================================

-- ---------- Tablas ----------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;
grant select on all tables in schema public to authenticated;

-- Escritura directa solo donde hay políticas RLS de administración (catálogos) y en clientes
do $$
declare t text;
begin
  foreach t in array array['sucursales','almacenes','cajas','series','categorias','marcas','productos',
    'unidades_venta','listas_precios','precios','producto_almacen','proveedores','sat_catalogo',
    'perfiles','usuario_sucursales','usuario_permisos','empresa']
  loop
    execute format('grant insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
grant insert, update on public.clientes to authenticated;
grant usage on all sequences in schema public to authenticated;

-- ---------- Funciones ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function
  public.es_admin(), public.tiene_permiso(text), public.opera_sucursal(uuid), public.opera_almacen(uuid),
  public.confirmar_venta(jsonb), public.cancelar_venta(uuid, text), public.registrar_entrega(jsonb),
  public.guardar_cotizacion(jsonb), public.cambiar_estado_cotizacion(uuid, text), public.preparar_conversion(uuid),
  public.calcular_unidades(uuid, numeric), public.calcular_partida(numeric, numeric, numeric, numeric, numeric, boolean),
  public.registrar_entrada(jsonb), public.enviar_traspaso(jsonb), public.marcar_traspaso_en_transito(uuid),
  public.recibir_traspaso(jsonb), public.cancelar_traspaso(uuid, text), public.registrar_ajuste(jsonb),
  public.saldo_cliente(uuid), public.lista_efectiva(uuid, uuid), public.costo_venta(uuid), public.exigir(boolean, text)
to authenticated;

-- Objetos futuros creados por este rol: sin privilegios implícitos
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke insert, update, delete, truncate, references, trigger on tables from authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
