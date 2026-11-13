/** Alta de productos: SKU automático, pisos en piezas con precios desde m², importación. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const piso = (over: Record<string, unknown> = {}) => ({
  presentacion: "piso", nombre: "Piso Ejemplo Gris", marca: "Marca Ejemplo", categoria: "Pisos", formato: "18x50",
  piezas_por_caja: 11, m2_por_caja: 0.99, precio_m2: 250, ...over,
});

describe("guardar_producto", () => {
  it("piso: SKU MARCA-FORMATO-###, base en PIEZA, CAJA = piezas y precios desde m²", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso());
    expect(r.sku).toBe("MAR-1850-001");
    const u = await q(`select u.nombre, u.factor::text, u.es_base, pr.precio::text from unidades_venta u
                         join precios pr on pr.unidad_venta_id = u.id where u.producto_id = $1 order by u.orden`, [r.producto_id]);
    expect(u).toEqual([
      { nombre: "CAJA", factor: "11.00000000", es_base: false, precio: "247.500000" },
      { nombre: "PIEZA", factor: "1.00000000", es_base: true, precio: "22.500000" },
      { nombre: "M2", factor: "11.11111111", es_base: false, precio: "250.000000" },
    ]);
    const [p] = await q(`select unidad_base, permite_fraccion, iva_tasa::text from productos where id = $1`, [r.producto_id]);
    expect(p).toEqual({ unidad_base: "PIEZA", permite_fraccion: false, iva_tasa: "0.0000" });
    const r2 = await rpc(s.admin, "guardar_producto", piso({ nombre: "Piso Ejemplo Beige" }));
    expect(r2.sku).toBe("MAR-1850-002");
  });
  it("producto por unidad sin marca toma el prefijo de la categoría", async () => {
    const r = await rpc(s.admin, "guardar_producto", { presentacion: "unidad", nombre: "Adhesivo ejemplo", categoria: "Adhesivos", unidad: "BULTO", precio: 199, marca: "Sin marca" });
    expect(r.sku).toBe("ADH-001");
    const [p] = await q(`select marca_id, unidad_base, clave_sat_unidad from productos where id = $1`, [r.producto_id]);
    expect(p).toEqual({ marca_id: null, unidad_base: "BULTO", clave_sat_unidad: "XBG" });
  });
  it("precios de piso sin redondear a centavos (pieza = área × precio m²)", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso({ nombre: "Piso Decimales", piezas_por_caja: 7, m2_por_caja: 1.5, precio_m2: 116.69 }));
    const u = await q(`select u.nombre, pr.precio::text from unidades_venta u join precios pr on pr.unidad_venta_id = u.id
                        where u.producto_id = $1 order by u.orden`, [r.producto_id]);
    expect(u).toEqual([{ nombre: "CAJA", precio: "175.035000" }, { nombre: "PIEZA", precio: "25.005000" }, { nombre: "M2", precio: "116.690000" }]);
  });

  it("edita precios y piezas; no permite cambiar la presentación", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso({ nombre: "Piso Edición" }));
    await rpc(s.admin, "guardar_producto", piso({ id: r.producto_id, nombre: "Piso Edición", piezas_por_caja: 10, precio_m2: 300 }));
    const [c] = await q(`select u.factor::text, pr.precio::text from unidades_venta u join precios pr on pr.unidad_venta_id = u.id
                          where u.producto_id = $1 and u.nombre = 'CAJA'`, [r.producto_id]);
    expect(c).toEqual({ factor: "10.00000000", precio: "297.000000" });
    await expect(rpc(s.admin, "guardar_producto", { id: r.producto_id, presentacion: "unidad", nombre: "X", precio: 1 })).rejects.toThrow(/presentación/);
  });
  it("valida SKU repetido y permisos", async () => {
    await rpc(s.admin, "guardar_producto", piso({ sku: "MI-SKU-1", nombre: "Con SKU" }));
    await expect(rpc(s.admin, "guardar_producto", piso({ sku: "mi-sku-1", nombre: "Otro" }))).rejects.toThrow(/Ya existe/);
    await expect(rpc(s.cajeroA, "guardar_producto", piso())).rejects.toThrow(/permiso/);
  });
});

describe("importar_productos", () => {
  it("crea productos, carga existencia en piezas y al reimportar actualiza sin duplicar existencia", async () => {
    const filas = [
      { fila: 2, ...piso({ marca: "Importada Ejemplo", formato: "60x60", nombre: "Mármol Ejemplo", piezas_por_caja: 2, m2_por_caja: 0.72, precio_m2: 500 }), cajas: 10, piezas_sueltas: 1 },
      { fila: 3, presentacion: "unidad", nombre: "Pegazulejo ejemplo", marca: "Otra Marca", categoria: "Adhesivos", unidad: "BULTO", precio: 180, cantidad: 25 },
    ];
    const r = await rpc(s.admin, "importar_productos", { idempotency_key: key(), almacen_id: s.almA, filas });
    expect(r).toMatchObject({ creados: 2, actualizados: 0, con_existencia: 2 });
    const [m] = await q(`select id, sku from productos where nombre = 'Mármol Ejemplo'`);
    expect(m.sku).toBe("IMP-6060-001");
    expect(await stock(m.id, s.almA)).toBe(21);
    const r2 = await rpc(s.admin, "importar_productos", { idempotency_key: key(), almacen_id: s.almA,
      filas: [{ ...filas[0], precio_m2: 550 }] });
    expect(r2).toMatchObject({ creados: 0, actualizados: 1, con_existencia: 0 });
    expect(await stock(m.id, s.almA)).toBe(21);
  });
  it("es todo o nada e indica la fila con error", async () => {
    const antes = (await q(`select count(*)::int n from productos`))[0].n;
    await expect(rpc(s.admin, "importar_productos", { idempotency_key: key(), almacen_id: s.almA, filas: [
      { fila: 2, presentacion: "unidad", nombre: "Bueno", unidad: "PIEZA", precio: 10 },
      { fila: 3, presentacion: "piso", nombre: "Malo sin piezas", m2_por_caja: 1, precio_m2: 100 },
    ] })).rejects.toThrow(/Fila 3: Piso: indica las piezas por caja/);
    expect((await q(`select count(*)::int n from productos`))[0].n).toBe(antes);
  });
});

describe("eliminar_producto", () => {
  it("elimina un producto sin uso (con sus unidades y precios)", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso({ nombre: "Piso Para Borrar" }));
    await rpc(s.admin, "eliminar_producto", { id: r.producto_id });
    expect((await q(`select count(*)::int n from productos where id = $1`, [r.producto_id]))[0].n).toBe(0);
    expect((await q(`select count(*)::int n from unidades_venta where producto_id = $1`, [r.producto_id]))[0].n).toBe(0);
  });

  it("no elimina si ya tiene movimientos de inventario; se puede desactivar", async () => {
    const imp = await rpc(s.admin, "importar_productos", { idempotency_key: key(), almacen_id: s.almA,
      filas: [{ fila: 1, ...piso({ nombre: "Piso Con Existencia" }), cajas: 2 }] });
    const id = imp.productos[0].producto_id;
    await expect(rpc(s.admin, "eliminar_producto", { id })).rejects.toThrow(/movimientos.*Desactívalo/);
    expect((await q(`select count(*)::int n from productos where id = $1`, [id]))[0].n).toBe(1);
  });
});

describe("productos sin precio", () => {
  it("se dan de alta sin precio y al reimportar sin precio se conserva el que ya tenían", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso({ nombre: "Piso Sin Precio", precio_m2: null }));
    expect((await q(`select count(*)::int n from precios pr join unidades_venta u on u.id = pr.unidad_venta_id where u.producto_id = $1`, [r.producto_id]))[0].n).toBe(0);
    const u = await rpc(s.admin, "guardar_producto", { presentacion: "unidad", nombre: "Llave sin precio", unidad: "PIEZA" });
    await rpc(s.admin, "guardar_producto", { id: u.producto_id, presentacion: "unidad", nombre: "Llave sin precio", unidad: "PIEZA", precio: 120 });
    await rpc(s.admin, "importar_productos", { idempotency_key: key(), filas: [{ fila: 1, sku: u.sku, presentacion: "unidad", nombre: "Llave sin precio", unidad: "PIEZA" }] });
    const [p] = await q(`select pr.precio::text from precios pr join unidades_venta u on u.id = pr.unidad_venta_id where u.producto_id = $1`, [u.producto_id]);
    expect(p.precio).toBe("120.000000");
  });
});

describe("productos sin descripción", () => {
  it("el nombre queda como marca + formato + SKU", async () => {
    const r = await rpc(s.admin, "guardar_producto", piso({ nombre: "", marca: "Marca Nombre", formato: "33x33" }));
    const [p] = await q(`select nombre from productos where id = $1`, [r.producto_id]);
    expect(p.nombre).toBe(`Marca Nombre 33x33 ${r.sku}`);
  });
});
