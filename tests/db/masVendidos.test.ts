/** 0050: productos más vendidos para la lista del buscador en Capturar venta. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const vender = (sucursal: string, almacen: string, partidas: unknown[]) => rpc(s.admin, "confirmar_venta", {
  idempotency_key: key(), sucursal_id: sucursal, almacen_id: almacen, tipo: "contado", pago_pendiente: true, cliente_id: s.clienteCredito, partidas, pagos: [],
});
const mv = (usuario: string, suc: string | null) =>
  asUser(usuario, async (c) => (await c.query(`select producto_id, ventas::int from productos_mas_vendidos($1, 30)`, [suc])).rows);

describe("productos_mas_vendidos", () => {
  it("ordena por número de ventas, filtra por sucursal e ignora canceladas", async () => {
    const piso = { producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360, entregar_ahora: false };
    const serv = { producto_id: s.servicio.id, unidad_venta_id: s.servicio.unidad, cantidad: 1, precio_unitario: 500 };
    await vender(s.sucA, s.almA, [piso]);
    await vender(s.sucA, s.almA, [piso, serv]);
    await vender(s.sucB, s.almB, [serv]);
    await vender(s.sucB, s.almB, [serv]);
    const cancelada = await vender(s.sucA, s.almA, [serv]);
    await q(`update ventas set estado = 'cancelada' where id = $1`, [cancelada.venta_id]);

    expect(await mv(s.cajeroA, s.sucA)).toEqual([{ producto_id: s.piso.id, ventas: 2 }, { producto_id: s.servicio.id, ventas: 1 }]);
    expect((await mv(s.cajeroA, null))[0]).toEqual({ producto_id: s.servicio.id, ventas: 3 });
  });
});
