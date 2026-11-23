/** 0055: pago de un cliente repartido entre sus notas con saldo (la más antigua primero). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const credito = (cajas: number) => rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "credito",
  cliente_id: s.clienteCredito, partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: cajas, precio_unitario: 360, entregar_ahora: false }], pagos: [] });
const saldo = async (id: string) => Number((await q(`select saldo from ventas where id = $1`, [id]))[0].saldo);

describe("registrar_pago_cliente", () => {
  it("reparte el pago de la nota más antigua a la más nueva, sin pasar del saldo, y no duplica al reintentar", async () => {
    const a = await credito(2), b = await credito(3);                 // 720 y 1080
    await q(`update ventas set vencimiento = current_date - 5 where id = $1`, [a.venta_id]);
    await expect(rpc(s.cajeroA, "registrar_pago_cliente", { idempotency_key: key(), cliente_id: s.clienteCredito, forma: "efectivo", importe: 5000 }))
      .rejects.toThrow(/excede/);
    const k = key();
    const r = await rpc(s.cajeroA, "registrar_pago_cliente", { idempotency_key: k, cliente_id: s.clienteCredito, forma: "transferencia", importe: 1000, referencia: "TRF-9" });
    expect(r.aplicado.map((x: { importe: number }) => Number(x.importe))).toEqual([720, 280]);
    expect(await saldo(a.venta_id)).toBe(0);
    expect(await saldo(b.venta_id)).toBe(800);
    const otra = await rpc(s.cajeroA, "registrar_pago_cliente", { idempotency_key: k, cliente_id: s.clienteCredito, forma: "transferencia", importe: 1000 });
    expect(otra.repetida).toBe(true);
    expect(await saldo(b.venta_id)).toBe(800);
  });

  it("solo a las notas elegidas, y el cajero de otra sucursal no cobra notas que no son suyas", async () => {
    const c = await credito(1), d = await credito(1);
    await rpc(s.cajeroA, "registrar_pago_cliente", { idempotency_key: key(), cliente_id: s.clienteCredito, forma: "efectivo", importe: 100, ventas: [d.venta_id] });
    expect(await saldo(c.venta_id)).toBe(360);
    expect(await saldo(d.venta_id)).toBe(260);
    await expect(rpc(s.cajeroB, "registrar_pago_cliente", { idempotency_key: key(), cliente_id: s.clienteCredito, forma: "efectivo", importe: 10 }))
      .rejects.toThrow(/no tiene notas con saldo que puedas cobrar/);
  });
});
