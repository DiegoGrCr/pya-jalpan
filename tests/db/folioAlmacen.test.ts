/** 0028: serie de remisiones por sucursal y almacén por renglón. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const venta = (partidas: object[]) => rpc(s.cajeroA, "confirmar_venta", {
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
  partidas, pagos: [{ forma: "efectivo", importe: 100000 }],
});

describe("serie de remisiones", () => {
  it("el administrador define la abreviación y el número siguiente", async () => {
    await rpc(s.admin, "guardar_serie", { sucursal_id: s.sucA, prefijo: "ar", siguiente: 1 });
    const v = await venta([{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }]);
    expect({ serie: v.serie, folio: Number(v.folio) }).toEqual({ serie: "AR", folio: 1 });
    // no deja repetir folios ya usados con esa abreviación
    await expect(rpc(s.admin, "guardar_serie", { sucursal_id: s.sucA, prefijo: "AR", siguiente: 1 })).rejects.toThrow(/ya existe hasta el folio 1/);
    // un vendedor no puede cambiarla
    await expect(rpc(s.cajeroA, "guardar_serie", { sucursal_id: s.sucA, prefijo: "XX", siguiente: 1 })).rejects.toThrow(/administrador/);
  });
});

describe("almacén por renglón", () => {
  it("cada renglón descuenta de su bodega y editar respeta el almacén", async () => {
    const [a0, b0] = [await stock(s.piso.id, s.almA), await stock(s.piso.id, s.almB)];
    const v = await venta([
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 },
      { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360, almacen_id: s.almB, entregar_ahora: false },
    ]);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(a0 - 1.44, 6);
    expect(await stock(s.piso.id, s.almB)).toBeCloseTo(b0 - 2.88, 6);
    const ps = await q(`select id, almacen_id from venta_partidas where venta_id = $1 order by renglon`, [v.venta_id]);
    expect(ps.map((x) => x.almacen_id)).toEqual([s.almA, s.almB]);
    // editar: el renglón de la bodega B baja a 1 caja -> regresa 1 caja a B
    await rpc(s.cajeroA, "editar_venta", { idempotency_key: key(), venta_id: v.venta_id, diferencia: "devolver", devolucion_forma: "efectivo", partidas: [
      { partida_id: ps[0].id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 },
      { partida_id: ps[1].id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360, almacen_id: s.almB },
    ] });
    expect(await stock(s.piso.id, s.almB)).toBeCloseTo(b0 - 1.44, 6);
    // cancelar devuelve cada bodega a su existencia original
    await asUser(s.cajeroA, (c) => c.query(`select public.cancelar_venta($1, 'Prueba')`, [v.venta_id]));
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(a0, 6);
    expect(await stock(s.piso.id, s.almB)).toBeCloseTo(b0, 6);
  });
});
