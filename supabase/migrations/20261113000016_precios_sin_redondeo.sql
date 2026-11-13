-- =============================================================================
-- 0016 · Precios unitarios sin redondear a centavos
-- El precio de la caja y de la pieza sale de m² × precio m² y se guarda tal cual da
-- (hasta 6 decimales, lo que admite el CFDI en ValorUnitario). Solo el importe de
-- cada renglón (cantidad × precio) se redondea a centavos, porque es dinero cobrado.
-- Se puede ejecutar más de una vez.
-- =============================================================================
alter table public.precios             alter column precio          type numeric(18,6);
alter table public.productos           alter column precio_m2       type numeric(18,6);
alter table public.cotizacion_partidas alter column precio_unitario type numeric(18,6);
alter table public.venta_partidas      alter column precio_unitario type numeric(18,6),
                                       alter column precio_lista    type numeric(18,6);
alter table public.apartado_partidas   alter column precio_unitario type numeric(18,6);

-- Recalcula los precios de pisos ya dados de alta con la fórmula sin redondeo
-- (solo donde el precio coincide con el calculado antes, para no pisar precios escritos a mano)
update public.precios pr set precio = pp.m2_por_caja * pp.precio_m2, actualizado_en = now()
  from public.unidades_venta u join public.productos pp on pp.id = u.producto_id
 where pr.unidad_venta_id = u.id and u.nombre = 'CAJA' and pp.presentacion = 'piso' and pp.precio_m2 is not null
   and pr.precio = round(pp.m2_por_caja * pp.precio_m2, 2);
update public.precios pr set precio = pp.m2_por_caja / pp.piezas_por_caja * pp.precio_m2, actualizado_en = now()
  from public.unidades_venta u join public.productos pp on pp.id = u.producto_id
 where pr.unidad_venta_id = u.id and u.es_base and pp.presentacion = 'piso' and pp.precio_m2 is not null
   and pr.precio in (round(pp.m2_por_caja / pp.piezas_por_caja * pp.precio_m2, 2),
                     round(round(pp.m2_por_caja * pp.precio_m2, 2) / pp.piezas_por_caja, 2));
