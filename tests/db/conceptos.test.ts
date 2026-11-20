/** 0044: conceptos genéricos (nombre y precio libres) y servicios en la venta. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, q, Seed } from "./setup";

let s: Seed;
let cvg: { id: string; u: string }, flete: { id: string; u: string };
beforeAll(async () => {
  await startDb(); s = await seed();
  const fila = async (sku: string) => (await q(`select p.id, u.id u from productos p join unidades_venta u on u.producto_id = p.id and u.es_base where p.sku = $1`, [sku]))[0];
  cvg = await fila("CVG"); flete = await fila("FLETE");
}, 180_000);
afterAll(async () => { await stopDb(); });

const vender = (partidas: object[], total: number) => rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA,
  tipo: "contado", partidas, pagos: [{ forma: "efectivo", importe: total }] });

describe("conceptos genéricos", () => {
  it("existen CVG y FLETE", () => {
    expect(cvg?.id).toBeTruthy();
    expect(flete?.id).toBeTruthy();
  });

  it("CVG exige nombre; guarda el nombre escrito, acepta cualquier precio, no mueve inventario y queda entregado", async () => {
    await expect(vender([{ producto_id: cvg.id, unidad_venta_id: cvg.u, cantidad: 2, precio_unitario: 75 }], 150)).rejects.toThrow(/nombre del concepto/);
    const v = await vender([
      { producto_id: cvg.id, unidad_venta_id: cvg.u, cantidad: 2, precio_unitario: 75, descripcion: "Zoclo especial", entregar_ahora: false },
      { producto_id: flete.id, unidad_venta_id: flete.u, cantidad: 1, precio_unitario: 350, descripcion: "esto se ignora" },
    ], 500);
    const p = await q(`select descripcion, cantidad, cantidad_entregada from venta_partidas where venta_id = $1 order by renglon`, [v.venta_id]);
    expect(p[0]).toMatchObject({ descripcion: "Zoclo especial" });
    expect(Number(p[0].cantidad_entregada)).toBe(2);           // servicio: no queda por entregar
    expect(p[1].descripcion).toBeNull();                        // FLETE no tiene nombre libre
    const [m] = await q(`select count(*)::int n from movimientos where producto_id in ($1, $2)`, [cvg.id, flete.id]);
    expect(m.n).toBe(0);
  });

  it("al editar la venta se puede cambiar el nombre del concepto", async () => {
    const v = await vender([{ producto_id: cvg.id, unidad_venta_id: cvg.u, cantidad: 1, precio_unitario: 100, descripcion: "Pieza suelta" }], 100);
    const [pt] = await q(`select id from venta_partidas where venta_id = $1`, [v.venta_id]);
    await rpc(s.cajeroA, "editar_venta", { idempotency_key: key(), venta_id: v.venta_id,
      partidas: [{ partida_id: pt.id, producto_id: cvg.id, unidad_venta_id: cvg.u, cantidad: 1, precio_unitario: 100, descripcion: "Pieza de muestra" }] });
    const [d] = await q(`select descripcion from venta_partidas where id = $1`, [pt.id]);
    expect(d.descripcion).toBe("Pieza de muestra");
  });

  it("en cotización también", async () => {
    const c = await rpc(s.cajeroA, "guardar_cotizacion", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, prospecto: "Cliente de ejemplo",
      partidas: [{ producto_id: cvg.id, unidad_venta_id: cvg.u, cantidad: 3, precio_unitario: 40, descripcion: "Separadores" }] });
    const [d] = await q(`select descripcion from cotizacion_partidas where cotizacion_id = $1`, [c.cotizacion_id]);
    expect(d.descripcion).toBe("Separadores");
  });
});
