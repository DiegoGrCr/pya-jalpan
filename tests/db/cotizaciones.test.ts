/** 0037: cotizaciones (alta, edición, cancelación y conversión a venta). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const cot = (over: object = {}) => ({
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, prospecto: "Cliente Ejemplo",
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360, comentario: "Para baño" }], ...over,
});

describe("cotizaciones", () => {
  it("alta sin IVA, edición con el mismo folio y conversión a venta", async () => {
    const r = await rpc(s.cajeroA, "guardar_cotizacion", cot());
    const [c] = await q(`select total::text, iva::text, sin_iva from cotizaciones where id = $1`, [r.cotizacion_id]);
    expect(c).toEqual({ total: "720.00", iva: "0.00", sin_iva: true });
    const e = await rpc(s.cajeroA, "guardar_cotizacion", cot({ id: r.cotizacion_id, partidas: [
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 }] }));
    expect(e.folio).toBe(r.folio);
    expect((await q(`select total::text t from cotizaciones where id = $1`, [r.cotizacion_id]))[0].t).toBe("1080.00");
    const v = await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
      cotizacion_id: r.cotizacion_id, partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 }],
      pagos: [{ forma: "efectivo", importe: 1080 }] });
    expect((await q(`select estado, venta_id from cotizaciones where id = $1`, [r.cotizacion_id]))[0]).toEqual({ estado: "convertida", venta_id: v.venta_id });
    await expect(rpc(s.cajeroA, "guardar_cotizacion", cot({ id: r.cotizacion_id }))).rejects.toThrow(/convertida/);
  });

  it("cancelar pide motivo", async () => {
    const r = await rpc(s.cajeroA, "guardar_cotizacion", cot());
    await expect(rpc(s.cajeroA, "cancelar_cotizacion", { id: r.cotizacion_id, motivo: "" })).rejects.toThrow(/motivo/);
    await rpc(s.cajeroA, "cancelar_cotizacion", { id: r.cotizacion_id, motivo: "El cliente ya no lo quiere" });
    expect((await q(`select estado from cotizaciones where id = $1`, [r.cotizacion_id]))[0].estado).toBe("cancelada");
  });
});
