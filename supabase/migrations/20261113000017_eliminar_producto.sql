-- =============================================================================
-- 0017 · Eliminar producto
-- Solo se elimina si nunca se usó: sin movimientos de inventario, ventas, cotizaciones,
-- apartados, entradas, traspasos ni ajustes (el kardex es inmutable). Si ya tiene historial,
-- se desactiva: deja de aparecer al vender y en la lista, pero su historial se conserva.
-- Se puede ejecutar más de una vez.
-- =============================================================================
create or replace function public.eliminar_producto(p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v productos%rowtype; p_id uuid := nullif(p->>'id','')::uuid;
begin
  perform exigir(tiene_permiso('editar_productos'), 'No tienes permiso para eliminar productos');
  select * into v from productos where id = p_id for update;
  perform exigir(v.id is not null, 'Producto no encontrado');
  perform exigir(not exists (select 1 from movimientos where producto_id = p_id),
    'El producto ya tiene movimientos de inventario (existencia inicial, ventas, entradas…) y no se puede eliminar. Desactívalo para que ya no aparezca.');
  delete from existencias where producto_id = p_id and cantidad = 0 and apartado = 0;
  begin
    delete from productos where id = p_id;   -- unidades de venta y precios se borran en cascada
  exception when foreign_key_violation then
    raise exception 'El producto ya se usó en cotizaciones, ventas u otros documentos y no se puede eliminar. Desactívalo para que ya no aparezca.';
  end;
  perform registrar_bitacora('eliminar', 'productos', p_id::text, to_jsonb(v), null);
  return jsonb_build_object('eliminado', true, 'sku', v.sku);
end $$;

revoke execute on function public.eliminar_producto(jsonb) from public, anon;
grant execute on function public.eliminar_producto(jsonb) to authenticated;
