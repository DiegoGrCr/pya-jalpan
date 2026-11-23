/** 0057: conteo físico (ajuste solo por diferencias, contra la existencia al guardar). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("registrar_conteo", () => {
  it("ajusta solo lo que difiere y deja el ajuste con origen conteo", async () => {
    await rpc(s.admin, "registrar_ajuste", { almacen_id: s.almA, motivo: "Inicial", origen: "inventario_inicial", idempotency_key: key(),
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.m2, cantidad: 100 }, { producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.m2, cantidad: 14.4 }] });
    const r = await rpc(s.admin, "registrar_conteo", { almacen_id: s.almA, idempotency_key: key(),
      partidas: [{ producto_id: s.piso.id, contado_base: 97.12 }, { producto_id: s.pisoCajas.id, contado_base: 14.4 }] });
    expect(r.sin_diferencias).toBe(false);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(97.12, 6);
    expect(await stock(s.pisoCajas.id, s.almA)).toBeCloseTo(14.4, 6);
    const aj = await q(`select origen, (select count(*)::int from ajuste_partidas where ajuste_id = a.id) n from ajustes a where a.id = $1`, [r.ajuste_id]);
    expect(aj[0]).toEqual({ origen: "conteo", n: 1 });
  });

  it("sin diferencias no crea ajuste; el cajero no puede contar", async () => {
    const r = await rpc(s.admin, "registrar_conteo", { almacen_id: s.almA, idempotency_key: key(), partidas: [{ producto_id: s.pisoCajas.id, contado_base: 14.4 }] });
    expect(r.sin_diferencias).toBe(true);
    await expect(rpc(s.cajeroA, "registrar_conteo", { almacen_id: s.almA, idempotency_key: key(), partidas: [{ producto_id: s.piso.id, contado_base: 1 }] }))
      .rejects.toThrow(/permiso/);
  });
});
