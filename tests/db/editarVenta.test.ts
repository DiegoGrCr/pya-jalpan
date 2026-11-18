/** Ventas editables (0027): inventario por diferencia, entregado, devolución / saldo a favor y cierre. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, Seed } from "./setup";

let s: Seed;
let cliente: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  cliente = (await q(`insert into clientes (nombre) values ('Cliente Edición Ejemplo') returning id`))[0].id;
}, 180_000);
afterAll(async () => { await stopDb(); });

const vender = async (cajas: number, pagos: number, extra: object = {}) => rpc(s.cajeroA, "confirmar_venta", {
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", cliente_id: cliente,
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: cajas, precio_unitario: 360, ...extra }],
  pagos: pagos ? [{ forma: "efectivo", importe: pagos }] : [], ...(pagos < cajas * 360 ? { pago_pendiente: true } : {}),
});
const partidas = async (venta: string) => q(`select id, cantidad::text, cantidad_base::text, total::text from venta_partidas where venta_id = $1 order by renglon`, [venta]);
const editar = (venta: string, filas: object[], extra: object = {}) =>
  rpc(s.cajeroA, "editar_venta", { idempotency_key: key(), venta_id: venta, partidas: filas, ...extra });

describe("editar_venta", () => {
  it("subir cantidad descuenta la diferencia del inventario y deja saldo", async () => {
    const v = await vender(2, 720);
    const antes = await stock(s.piso.id, s.almA);
    const [p] = await partidas(v.venta_id);
    const r = await editar(v.venta_id, [{ partida_id: p.id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 3, precio_unitario: 360 }]);
    expect(Number(r.total)).toBe(1080);
    expect(Number(r.saldo)).toBe(360);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes - 1.44, 6);   // 1 caja = 1.44 en unidad base
  });

  it("bajar el total por debajo de lo pagado exige decidir; devolver registra la devolución", async () => {
    const v = await vender(3, 1080, { entregar_ahora: false });
    const [p] = await partidas(v.venta_id);
    const fila = { partida_id: p.id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 };
    await expect(editar(v.venta_id, [fila])).rejects.toThrow(/devuelve o queda a favor/);
    const r = await editar(v.venta_id, [fila], { diferencia: "devolver", devolucion_forma: "efectivo" });
    expect(Number(r.exceso)).toBe(720);
    const [d] = await q(`select forma, importe::text from venta_devoluciones where venta_id = $1`, [v.venta_id]);
    expect(d).toEqual({ forma: "efectivo", importe: "720.00" });
    const [vv] = await q(`select total::text, pagado::text, saldo::text, ediciones from ventas where id = $1`, [v.venta_id]);
    expect(vv).toEqual({ total: "360.00", pagado: "360.00", saldo: "0.00", ediciones: 1 });
  });

  it("saldo a favor: se abona al cliente y se puede usar para pagar otra venta", async () => {
    const v = await vender(2, 720, { entregar_ahora: false });
    const [p] = await partidas(v.venta_id);
    await editar(v.venta_id, [{ partida_id: p.id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], { diferencia: "saldo_favor" });
    expect((await q(`select saldo_a_favor::text s from clientes where id = $1`, [cliente]))[0].s).toBe("360.00");
    const otra = await rpc(s.cajeroA, "confirmar_venta", {
      idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", cliente_id: cliente,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }],
      pagos: [{ forma: "saldo_favor", importe: 360 }],
    });
    expect((await q(`select saldo_a_favor::text s from clientes where id = $1`, [cliente]))[0].s).toBe("0.00");
    // cancelar esa venta regresa el saldo a favor
    const { asUser } = await import("./setup");
    await asUser(s.cajeroA, (c) => c.query(`select public.cancelar_venta($1, 'Prueba')`, [otra.venta_id]));
    expect((await q(`select saldo_a_favor::text s from clientes where id = $1`, [cliente]))[0].s).toBe("360.00");
  });

  it("no deja quitar ni bajar de lo entregado, y una venta cerrada ya no se edita", async () => {
    const v = await vender(2, 720);   // entregar_ahora por omisión: entregada
    const [p] = await partidas(v.venta_id);
    const fila = { partida_id: p.id, producto_id: s.piso.id, unidad_venta_id: s.piso.caja, precio_unitario: 360 };
    await expect(editar(v.venta_id, [{ ...fila, cantidad: 1 }], { diferencia: "devolver", devolucion_forma: "efectivo" })).rejects.toThrow(/ya entregado/);
    await expect(editar(v.venta_id, [{ producto_id: s.piso.id, unidad_venta_id: s.piso.pieza, cantidad: 1, precio_unitario: 90 }])).rejects.toThrow(/ya se entregó/);
    const { asUser } = await import("./setup");
    await asUser(s.cajeroA, (c) => c.query(`select public.cerrar_venta($1)`, [v.venta_id]));
    await expect(editar(v.venta_id, [{ ...fila, cantidad: 3 }])).rejects.toThrow(/cerrada/);
  });

  it("agregar y quitar renglones no entregados mueve el inventario neto; cancelar lo devuelve todo", async () => {
    const antes = await stock(s.piso.id, s.almA);
    const v = await vender(2, 0, { entregar_ahora: false });
    const [p] = await partidas(v.venta_id);
    await editar(v.venta_id, [{ producto_id: s.piso.id, unidad_venta_id: s.piso.pieza, cantidad: 5, precio_unitario: 90 }]);   // quita las cajas, agrega piezas
    expect((await partidas(v.venta_id)).map((x) => x.cantidad)).toEqual(["5.000000"]);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes - 5 * 0.36, 6);
    void p;
    const { asUser } = await import("./setup");
    await asUser(s.admin, (c) => c.query(`select public.cancelar_venta($1, 'Prueba')`, [v.venta_id]));
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes, 6);
  });
});
