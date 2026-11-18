/** Reporte histórico de ventas: filtros, estatus y permisos por sucursal. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => {
  await startDb(); s = await seed();
  await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", orden_compra: "OC-77",
    partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 720 }] });
}, 180_000);
afterAll(async () => { await stopDb(); });

const consulta = (u: string, fn: string, p: object) =>
  asUser(u, async (c) => (await c.query(`select * from public.${fn}($1::jsonb)`, [JSON.stringify(p)])).rows);

describe("reporte_ventas", () => {
  it("lista la venta con estatus pagada y respeta filtros", async () => {
    expect((await consulta(s.cajeroA, "reporte_ventas", {})).length).toBeGreaterThan(0);
    const oc = await consulta(s.cajeroA, "reporte_ventas", { orden_compra: "OC-77" });
    expect(oc).toHaveLength(1);
    expect(oc[0]).toMatchObject({ estatus: "pagada", total: "720.00" });
    expect(await consulta(s.cajeroA, "reporte_ventas", { orden_compra: "OC-77", estatus: "cancelada" })).toHaveLength(0);
  });
  it("un vendedor de otra sucursal no ve esas ventas", async () => {
    expect(await consulta(s.cajeroB, "reporte_ventas", { orden_compra: "OC-77" })).toHaveLength(0);
  });
  it("partidas para agrupar por producto", async () => {
    const r = await consulta(s.cajeroA, "reporte_ventas_partidas", { orden_compra: "OC-77" });
    expect(r).toHaveLength(1);
    expect(r[0].producto_id).toBe(s.piso.id);
  });
});
