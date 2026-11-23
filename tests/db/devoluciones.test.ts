/** 0051: devoluciones — cajas + piezas, saldo a favor en ventas de Público en general y regla de tarjeta. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, stock, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const vender = (usuario: string, partidas: unknown[], pagos: unknown[], cliente?: string) => rpc(usuario, "confirmar_venta", {
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", cliente_id: cliente ?? null, partidas, pagos,
});
const partida = async (venta: string) => (await q(`select id from venta_partidas where venta_id = $1`, [venta]))[0].id as string;
const devolver = (usuario: string, venta: string, pid: string, cantidad: number, extra: Record<string, unknown>) =>
  rpc(usuario, "devolver_productos", { idempotency_key: key(), venta_id: venta, motivo: "Devolución de material", partidas: [{ partida_id: pid, cantidad }], ...extra });
const cajas = (n: number) => [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: n, precio_unitario: 360 }];

describe("regla de tarjeta", () => {
  it("pagada con tarjeta: el cajero no devuelve en efectivo ni transferencia; sí a saldo a favor o a tarjeta; el administrador sí", async () => {
    const v = await vender(s.cajeroA, cajas(4), [{ forma: "tarjeta_credito", importe: 1440 }], s.clienteCredito);
    const pid = await partida(v.venta_id);
    await expect(devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "dinero", forma: "efectivo" })).rejects.toThrow(/pagó con tarjeta.*contacta a matriz/);
    await expect(devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "dinero", forma: "transferencia" })).rejects.toThrow(/tarjeta/);
    expect(Number((await devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "saldo_favor" })).importe)).toBe(360);
    expect(Number((await devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "dinero", forma: "tarjeta_credito" })).importe)).toBe(360);
    expect(Number((await devolver(s.admin, v.venta_id, pid, 1, { destino: "dinero", forma: "efectivo" })).importe)).toBe(360);
  });

  it("pago mixto: en efectivo solo hasta lo que pagó en efectivo", async () => {
    const v = await vender(s.cajeroA, cajas(3), [{ forma: "efectivo", importe: 500 }, { forma: "tarjeta_debito", importe: 580 }]);
    const pid = await partida(v.venta_id);
    await devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "dinero", forma: "efectivo" });                        // 360 ≤ 500
    await expect(devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "dinero", forma: "efectivo" })).rejects.toThrow(/más de \$140\.00/);
  });

  it("pagada en efectivo: sin restricción", async () => {
    const v = await vender(s.cajeroA, cajas(2), [{ forma: "efectivo", importe: 720 }]);
    expect(Number((await devolver(s.cajeroA, v.venta_id, await partida(v.venta_id), 2, { destino: "dinero", forma: "efectivo" })).importe)).toBe(720);
  });
});

describe("Público en general → saldo a favor", () => {
  it("pide un cliente registrado y le deja el saldo a él", async () => {
    const v = await vender(s.cajeroA, cajas(2), [{ forma: "efectivo", importe: 720 }]);
    const pid = await partida(v.venta_id);
    await expect(devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "saldo_favor" })).rejects.toThrow(/elige o da de alta/);
    const publico = (await q(`select id from clientes where es_publico_general`))[0].id;
    await expect(devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "saldo_favor", cliente_id: publico })).rejects.toThrow(/elige o da de alta/);
    const cl = (await q(`insert into clientes (nombre, telefono) values ('Cliente Mostrador Ficticio', '4410000001') returning id`))[0].id;
    await devolver(s.cajeroA, v.venta_id, pid, 1, { destino: "saldo_favor", cliente_id: cl });
    expect(Number((await q(`select saldo_a_favor from clientes where id = $1`, [cl]))[0].saldo_a_favor)).toBe(360);
    expect((await q(`select cliente_id from devoluciones_producto where venta_id = $1`, [v.venta_id]))[0].cliente_id).toBe(cl);
  });
});

describe("cajas + piezas", () => {
  it("2 cajas y 3 piezas regresan 3.96 m² y cobran lo proporcional", async () => {
    const v = await vender(s.cajeroA, cajas(5), [{ forma: "efectivo", importe: 1800 }]);
    const st = await stock(s.piso.id, s.almA);
    const r = await devolver(s.cajeroA, v.venta_id, await partida(v.venta_id), 2.75, { destino: "dinero", forma: "efectivo" });   // 4 piezas por caja
    expect(Number(r.importe)).toBe(990);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(st + 3.96, 6);
  });

  it("de pieza en pieza con 6 piezas por caja se puede devolver la caja completa sin error de redondeo", async () => {
    const pr = (await q(`insert into productos (sku, nombre, unidad_base, clave_sat_unidad, costo_promedio) values ('PIS-006','Piso Seis Piezas Ficticio','M2','MTK',100) returning id`))[0].id;
    const caja = (await q(`insert into unidades_venta (producto_id, nombre, factor, clave_sat_unidad) values ($1,'CAJA',1.44,'XBX') returning id`, [pr]))[0].id;
    await q(`insert into precios (lista_id, unidad_venta_id, precio) values ($1,$2,600)`, [s.lista, caja]);
    const v = await vender(s.cajeroA, [{ producto_id: pr, unidad_venta_id: caja, cantidad: 1, precio_unitario: 600 }], [{ forma: "efectivo", importe: 600 }]);
    const pid = await partida(v.venta_id);
    let total = 0;
    for (let i = 0; i < 6; i++) total += Number((await devolver(s.cajeroA, v.venta_id, pid, 0.166667, { destino: "dinero", forma: "efectivo" })).importe);
    expect((await q(`select cantidad_devuelta::text from venta_partidas where id = $1`, [pid]))[0].cantidad_devuelta).toBe("1.000000");
    expect(total).toBeCloseTo(600, 0);
  });
});
