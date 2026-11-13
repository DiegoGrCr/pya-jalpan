-- =====================================================================
-- Datos de DEMOSTRACIÓN ficticios para probar el punto de venta.
-- Opcional. Ejecutar después de 01_configuracion_inicial.sql.
-- Para quitarlos antes de la carga real, usa una base nueva o bórralos manualmente.
-- =====================================================================
begin;

with p as (
  insert into productos (sku, nombre, unidad_base, clave_sat_unidad, clave_sat_prodserv, costo_promedio, ultimo_costo, permite_fraccion)
  values ('DEMO-001', 'Piso cerámico demo 60x60', 'M2', 'MTK', '30161602', 150, 150, true),
         ('DEMO-002', 'Porcelanato demo (solo cajas)', 'M2', 'MTK', '30161602', 220, 220, false)
  returning id, sku
)
insert into unidades_venta (producto_id, nombre, factor, clave_sat_unidad, orden)
select id, 'CAJA', 1.44, 'XBX', 1 from p
union all
select id, 'PIEZA', 0.36, 'H87', 2 from p where sku = 'DEMO-001';

-- Precios (lista predeterminada): por m², por caja y por pieza
insert into precios (lista_id, unidad_venta_id, precio)
select l.id, u.id,
       case when u.nombre = 'CAJA' then (case pr.sku when 'DEMO-001' then 360 else 475 end)
            when u.nombre = 'PIEZA' then 90
            else (case pr.sku when 'DEMO-001' then 250 else 330 end) end
  from unidades_venta u join productos pr on pr.id = u.producto_id
 cross join listas_precios l
 where l.predeterminada and pr.sku like 'DEMO-%';

commit;

-- Existencia inicial demo (100 m² por almacén) mediante la función de ajustes, para que quede
-- en el kardex. En el SQL Editor no hay sesión: se actúa a nombre del administrador.
select set_config('request.jwt.claims',
  json_build_object('sub', (select user_id from perfiles where rol = 'administrador' limit 1))::text, false);

select registrar_ajuste(jsonb_build_object(
  'almacen_id', a.id, 'motivo', 'Existencia demo', 'origen', 'inventario_inicial',
  'idempotency_key', 'demo-inicial-' || a.id,
  'partidas', (select jsonb_agg(jsonb_build_object('producto_id', u.producto_id, 'unidad_venta_id', u.id, 'cantidad', 100))
                 from unidades_venta u join productos p on p.id = u.producto_id
                where u.es_base and p.sku like 'DEMO-%')))
  from almacenes a;
