-- =============================================================================
-- REINICIAR DATOS DE PRUEBA  ·  ¡BORRA INFORMACIÓN Y NO SE PUEDE DESHACER!
-- No es una migración: se ejecuta a mano, una sola vez, en el SQL Editor de Supabase.
--
-- BORRA: ventas, pagos, devoluciones, cotizaciones, apartados, entregas, entradas, traspasos,
--        ajustes, existencias y kardex, cortes de caja, retiros y gastos, movimientos de saldo
--        a favor, bitácora (historial), TODOS los productos (con sus precios y unidades) y
--        TODOS los clientes excepto "Público en General".
-- REINICIA: todos los folios (remisiones, cotizaciones, cortes, etc.) a 1.
-- CONSERVA: empresa, sucursales, almacenes, cajas, usuarios y permisos, listas de precios,
--           categorías, marcas, proveedores, series (con su prefijo) y catálogo del SAT.
--
-- Todo va en una transacción: si algo falla, no se borra nada.
-- =============================================================================
begin;

-- Movimientos de operación, inventario y productos (truncate no dispara los candados del kardex)
truncate table
  public.venta_pagos, public.venta_devoluciones, public.devoluciones_producto, public.venta_partidas, public.ventas,
  public.cotizacion_partidas, public.cotizaciones,
  public.apartado_pagos, public.apartado_partidas, public.apartados,
  public.entrega_partidas, public.entregas,
  public.entrada_partidas, public.entradas,
  public.traspaso_partidas, public.traspasos,
  public.ajuste_partidas, public.ajustes, public.ajustes_costo_venta, public.costo_pendiente,
  public.movimientos, public.existencias,
  public.retiros_caja, public.cortes_caja,
  public.saldo_favor_movimientos,
  public.bitacora,
  public.precios, public.unidades_venta, public.producto_almacen, public.productos;

-- Clientes: solo queda Público en General, sin saldo a favor
delete from public.clientes where not es_publico_general;
update public.clientes set saldo_a_favor = 0 where es_publico_general and saldo_a_favor <> 0;

-- Folios desde 1
update public.series set siguiente = 1;

commit;

-- Comprobación (todo debe salir en 0, clientes en 1)
select (select count(*) from public.ventas) ventas, (select count(*) from public.cotizaciones) cotizaciones,
       (select count(*) from public.productos) productos, (select count(*) from public.movimientos) movimientos,
       (select count(*) from public.cortes_caja) cortes, (select count(*) from public.clientes) clientes,
       (select max(siguiente) from public.series) siguiente_folio;
