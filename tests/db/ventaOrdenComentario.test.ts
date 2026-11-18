/** Orden de compra de la venta y comentario por renglón (0020). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("Venta con orden de compra y comentarios", () => {
  it("guarda la orden de compra y el comentario de cada renglón", async () => {
    const r = await rpc(s.cajeroA, "confirmar_venta", {
      idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", orden_compra: " OC-123 ",
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360, comentario: "Entregar en obra" }],
      pagos: [{ forma: "efectivo", importe: 360 }],
    });
    const [v] = await q(`select v.orden_compra, p.comentario from ventas v join venta_partidas p on p.venta_id = v.id where v.id = $1`, [r.venta_id]);
    expect(v).toEqual({ orden_compra: "OC-123", comentario: "Entregar en obra" });
  });
});
