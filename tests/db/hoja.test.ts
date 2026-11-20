/** 0048: inventario desde hoja de cálculo por almacén. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, q, stock, Seed } from "./setup";

let s: Seed;
let piso: { id: string; sku: string };
beforeAll(async () => {
  await startDb(); s = await seed();
  const r = await rpc(s.admin, "guardar_producto", { presentacion: "piso", sku: "HOJA-001", nombre: "Piso de prueba hoja", piezas_por_caja: 10, m2_por_caja: 1.5, precio_m2: 200 });
  piso = { id: r.producto_id, sku: "HOJA-001" };
}, 180_000);
afterAll(async () => { await stopDb(); });

describe("inventario desde hoja", () => {
  it("solo administrador configura; sin enlace no se puede elegir hoja", async () => {
    await expect(rpc(s.cajeroA, "configurar_hoja_almacen", { almacen_id: s.almA, fuente: "hoja", hoja_url: "https://docs.google.com/spreadsheets/d/abc" })).rejects.toThrow(/administrador/);
    await expect(rpc(s.admin, "configurar_hoja_almacen", { almacen_id: s.almA, fuente: "hoja" })).rejects.toThrow(/enlace/);
    await expect(rpc(s.admin, "configurar_hoja_almacen", { almacen_id: s.almA, fuente: "hoja", hoja_url: "https://otro.com/x" })).rejects.toThrow(/Google/);
    await expect(rpc(s.cajeroA, "sincronizar_hoja", { almacen_id: s.almA, filas: [] })).rejects.toThrow(/no usa hoja/);
    await rpc(s.admin, "configurar_hoja_almacen", { almacen_id: s.almA, fuente: "hoja", hoja_url: "https://docs.google.com/spreadsheets/d/abc123/edit" });
  });

  it("iguala la existencia a la hoja (cajas × piezas + sueltas), reporta SKU desconocidos y deja rastro en el kardex", async () => {
    const r = await rpc(s.cajeroA, "sincronizar_hoja", { almacen_id: s.almA, filas: [
      { sku: "hoja-001", cajas: 7, sueltas: 3 }, { sku: "NO-EXISTE", cantidad: 5 } ] });
    expect(await stock(piso.id, s.almA)).toBe(73);
    expect(r.cambios).toBe(1);
    expect(r.desconocidos).toEqual(["NO-EXISTE"]);
    const [m] = await q(`select tipo, cantidad, nota from movimientos where producto_id = $1 and almacen_id = $2 order by id desc limit 1`, [piso.id, s.almA]);
    expect(m.tipo).toBe("ajuste");
    expect(Number(m.cantidad)).toBe(73);
    // una venta descuenta; la siguiente lectura vuelve a lo que diga la hoja
    await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
      partidas: [{ producto_id: piso.id, unidad_venta_id: (await q(`select id from unidades_venta where producto_id = $1 and es_base`, [piso.id]))[0].id, cantidad: 3, precio_unitario: 30 }],
      pagos: [{ forma: "efectivo", importe: 90 }] });
    expect(await stock(piso.id, s.almA)).toBe(70);
    const r2 = await rpc(s.cajeroA, "sincronizar_hoja", { almacen_id: s.almA, filas: [{ sku: "HOJA-001", cajas: 7, sueltas: 0 }] });
    expect(await stock(piso.id, s.almA)).toBe(70);
    expect(r2.cambios).toBe(0);
    expect(r2.iguales).toBe(1);
    const r3 = await rpc(s.cajeroA, "sincronizar_hoja", { almacen_id: s.almA, filas: [{ sku: "HOJA-001", cantidad: 12 }] });
    expect(await stock(piso.id, s.almA)).toBe(12);
    expect(r3.cambios).toBe(1);
  });
});
