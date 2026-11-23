/** 0053: rol Contabilidad / Facturación — ve todas las sucursales y no opera nada. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, stopDb, seed, rpc, q, key, asUser, Seed } from "./setup";

let s: Seed;
let conta: string;
let ventaNorte: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  conta = randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'contadora@ejemplo.test')`, [conta]);
  await q(`insert into perfiles (user_id, nombre, rol) values ($1, 'Contadora Ficticia', 'facturacion')`, [conta]);
  await q(`insert into usuario_sucursales values ($1, $2)`, [conta, s.sucA]);   // aun con sucursal asignada, no opera
  const v = await rpc(s.cajeroB, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucB, almacen_id: s.almB,
    partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 360 }] });
  ventaNorte = v.venta_id;
}, 180_000);
afterAll(async () => { await stopDb(); });

const ver = (sql: string, params: unknown[] = []) => asUser(conta, async (c) => (await c.query(sql, params)).rows);

describe("rol Contabilidad", () => {
  it("ve ventas, partidas y pagos de todas las sucursales (también las no asignadas)", async () => {
    expect((await ver(`select id from ventas where id = $1`, [ventaNorte])).length).toBe(1);
    expect((await ver(`select id from venta_partidas where venta_id = $1`, [ventaNorte])).length).toBe(1);
    expect((await ver(`select id from venta_pagos where venta_id = $1`, [ventaNorte])).length).toBe(1);
    // el cajero del Centro no ve la del Norte
    expect((await asUser(s.cajeroA, async (c) => (await c.query(`select id from ventas where id = $1`, [ventaNorte])).rows)).length).toBe(0);
  });

  it("ve el corte de cualquier sucursal y el historial de una venta, pero no cierra cortes", async () => {
    const r = await rpc(conta, "corte_resumen", { sucursal_id: s.sucB });
    expect(r).toBeTruthy();
    const h = await ver(`select * from historial_venta($1)`, [ventaNorte]);
    expect(Array.isArray(h)).toBe(true);
    await expect(rpc(conta, "cerrar_corte", { sucursal_id: s.sucB, contado: {} })).rejects.toThrow();
  });

  it("no vende, no cobra, no aparta, no da de alta clientes", async () => {
    const partidas = [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }];
    await expect(rpc(conta, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, partidas, pagos: [{ forma: "efectivo", importe: 360 }] }))
      .rejects.toThrow(/No puedes vender/);
    await expect(rpc(conta, "registrar_pago_venta", { idempotency_key: key(), venta_id: ventaNorte, forma: "efectivo", importe: 1 })).rejects.toThrow();
    await expect(rpc(conta, "crear_apartado", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, cliente_id: s.cliente, partidas, pagos: [] }))
      .rejects.toThrow(/No puedes apartar/);
    await expect(asUser(conta, (c) => c.query(`insert into clientes (nombre) values ('Cliente de la contadora')`))).rejects.toThrow(/row-level security/);
    await expect(asUser(conta, (c) => c.query(`update clientes set telefono = '1' where id = $1`, [s.cliente]))).resolves.toMatchObject({ rowCount: 0 });
  });

  it("los demás roles siguen igual: el cajero opera su sucursal y da de alta clientes", async () => {
    await asUser(s.cajeroA, (c) => c.query(`insert into clientes (nombre) values ('Cliente Ficticio Cajero')`));
    const v = await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 360 }] });
    expect(v.venta_id).toBeTruthy();
  });
});
