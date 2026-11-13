/** Ventas sin IVA (remisión): el precio es el importe final y la tasa de IVA queda en 0. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const venta = (over: Record<string, unknown> = {}) => ({
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }],
  pagos: [{ forma: "efectivo", importe: 360 }],
  ...over,
});
const leer = async (id: string) => (await q(
  `select v.sin_iva, v.subtotal::text, v.iva::text, v.total::text, p.iva_tasa::text
     from ventas v join venta_partidas p on p.venta_id = v.id where v.id = $1`, [id]))[0];

describe("Venta sin IVA", () => {
  it("por omisión se guarda sin IVA: total = precio, IVA 0", async () => {
    const r = await rpc(s.cajeroA, "confirmar_venta", venta());
    expect(await leer(r.venta_id)).toEqual({ sin_iva: true, subtotal: "360.00", iva: "0.00", total: "360.00", iva_tasa: "0.0000" });
  });
  it("con sin_iva = false se desglosa el IVA del producto y el total no cambia", async () => {
    await q(`update productos set iva_tasa = 0.16 where id = $1`, [s.piso.id]); // producto que sí lleva IVA
    const r = await rpc(s.cajeroA, "confirmar_venta", venta({ sin_iva: false }));
    const v = await leer(r.venta_id);
    expect(v).toMatchObject({ sin_iva: false, total: "360.00", iva_tasa: "0.1600" });
    expect(Number(v.subtotal) + Number(v.iva)).toBeCloseTo(360, 2);
    expect(Number(v.iva)).toBeGreaterThan(0);
  });
});
