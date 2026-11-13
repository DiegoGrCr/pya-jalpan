/** Pisos por M2: la cantidad en m² debe equivaler a piezas completas; la existencia se descuenta en piezas. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
let prod: { id: string; m2: string; caja: string };
beforeAll(async () => {
  await startDb(); s = await seed();
  const r = await rpc(s.admin, "guardar_producto", { presentacion: "piso", nombre: "Piso M2 Ejemplo", formato: "30x30",
    piezas_por_caja: 12, m2_por_caja: 1.08, precio_m2: 250 });
  const u = await q(`select id, nombre from unidades_venta where producto_id = $1`, [r.producto_id]);
  prod = { id: r.producto_id, m2: u.find((x) => x.nombre === "M2").id, caja: u.find((x) => x.nombre === "CAJA").id };
}, 180_000);
afterAll(async () => { await stopDb(); });

const venta = (unidad: string, cantidad: number, precio: number) => ({
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
  partidas: [{ producto_id: prod.id, unidad_venta_id: unidad, cantidad, precio_unitario: precio }],
  pagos: [{ forma: "efectivo", importe: 99999 }],
});

describe("Venta de pisos por M2", () => {
  it("la unidad M2 existe con precio = precio por m²", async () => {
    const [u] = await q(`select u.factor::text, pr.precio::text from unidades_venta u join precios pr on pr.unidad_venta_id = u.id where u.id = $1`, [prod.m2]);
    expect(u).toEqual({ factor: "11.11111111", precio: "250.000000" });
  });

  it("10.08 M2 = 112 piezas y el importe es m² × precio", async () => {
    const r = await rpc(s.cajeroA, "confirmar_venta", venta(prod.m2, 10.08, 250));
    const [p] = await q(`select cantidad::text, cantidad_base::text, total::text from venta_partidas where venta_id = $1`, [r.venta_id]);
    expect(p).toEqual({ cantidad: "10.080000", cantidad_base: "112.000000", total: "2520.00" });
  });

  it("10 M2 no son piezas completas: se rechaza", async () => {
    await expect(rpc(s.cajeroA, "confirmar_venta", venta(prod.m2, 10, 250))).rejects.toThrow(/unidades completas/);
  });

  it("media caja (6 piezas) sí se permite", async () => {
    const r = await rpc(s.cajeroA, "confirmar_venta", venta(prod.caja, 0.5, 270));
    const [p] = await q(`select cantidad_base::text from venta_partidas where venta_id = $1`, [r.venta_id]);
    expect(p.cantidad_base).toBe("6.000000");
  });
});
