/** 0031: tablero de inicio. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => {
  await startDb(); s = await seed();
  await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
    partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 720 }] });
}, 180_000);
afterAll(async () => { await stopDb(); });

describe("tablero", () => {
  it("resume ventas, cobros y capital del periodo, respetando sucursales", async () => {
    const t = await rpc(s.cajeroA, "tablero", {});
    expect(t.ventas_mes).toHaveLength(24);
    expect(Number(t.periodo.ventas_total)).toBeGreaterThanOrEqual(720);
    expect(Number(t.periodo.cobrado)).toBeGreaterThanOrEqual(720);
    expect(t.productos[0].sku).toBeTruthy();
    expect(t.productos_cantidad[0].sku).toBeTruthy();
    expect(Number(t.productos_cantidad[0].medida)).toBeGreaterThan(0);
    const b = await rpc(s.cajeroB, "tablero", { sucursal_id: s.sucA });
    expect(Number(b.periodo.ventas_total)).toBe(0);   // otra sucursal: no ve esas ventas
  });
});
