/** 0038: cartera (saldo a favor), cambio a favor y devolución de productos. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, asUser, Seed } from "./setup";

let s: Seed;
let cliente: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  cliente = (await q(`insert into clientes (nombre) values ('Cliente Cartera Ejemplo') returning id`))[0].id;
}, 180_000);
afterAll(async () => { await stopDb(); });
const favor = async () => Number((await q(`select saldo_a_favor s from clientes where id = $1`, [cliente]))[0].s);

describe("cartera de clientes", () => {
  it("abonar a saldo a favor y no se puede editar directo", async () => {
    await rpc(s.cajeroA, "abonar_saldo_favor", { idempotency_key: key(), cliente_id: cliente, importe: 500, forma: "efectivo", referencia: "Para su próxima compra" });
    expect(await favor()).toBe(500);
    await expect(asUser(s.cajeroA, (c) => c.query(`update clientes set saldo_a_favor = 99999 where id = $1`, [cliente]))).rejects.toThrow(/saldo a favor/);
  });

  it("dejar el cambio como saldo a favor", async () => {
    const antes = await favor();
    await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", cliente_id: cliente, cambio_a_favor: true,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 500 }] });
    expect(await favor()).toBe(antes + 140);
  });

  it("devolver productos: regresa al inventario, abona a favor, cierra la venta y ya no se cancela", async () => {
    const v = await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", cliente_id: cliente,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 }], pagos: [{ forma: "tarjeta_debito", importe: 1080 }] });
    const [p] = await q(`select id from venta_partidas where venta_id = $1`, [v.venta_id]);
    const st = await stock(s.piso.id, s.almA), fa = await favor();
    await expect(rpc(s.cajeroA, "devolver_productos", { idempotency_key: key(), venta_id: v.venta_id, motivo: "Le sobró", destino: "saldo_favor",
      partidas: [{ partida_id: p.id, cantidad: 4 }] })).rejects.toThrow(/solo puedes devolver/);
    const r = await rpc(s.cajeroA, "devolver_productos", { idempotency_key: key(), venta_id: v.venta_id, motivo: "Le sobró", destino: "saldo_favor",
      partidas: [{ partida_id: p.id, cantidad: 1 }] });
    expect(Number(r.importe)).toBe(360);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(st + 1.44, 6);
    expect(await favor()).toBe(fa + 360);
    expect((await q(`select cerrada from ventas where id = $1`, [v.venta_id]))[0].cerrada).toBe(true);
    await expect(asUser(s.cajeroA, (c) => c.query(`select public.cancelar_venta($1, 'x')`, [v.venta_id]))).rejects.toThrow(/devoluciones/);
  });
});

describe("clientes_cartera", () => {
  it("lista al cliente con su saldo a favor", async () => {
    const r = await asUser(s.cajeroA, async (c) => (await c.query(`select * from public.clientes_cartera($1::jsonb)`, [JSON.stringify({ texto: "Cartera Ejemplo", filtro: "favor" })])).rows);
    expect(r).toHaveLength(1);
    expect(Number(r[0].saldo_a_favor)).toBeGreaterThan(0);
  });
});
