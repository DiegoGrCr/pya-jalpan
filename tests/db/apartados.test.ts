/** Apartados: anticipo mínimo, reserva sin descontar, abonos, liquidación a venta y cancelación con retención. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, asUser, q, key, stock, Seed } from "./setup";

let s: Seed;

beforeAll(async () => {
  await startDb();
  s = await seed();
  await rpc(s.admin, "registrar_ajuste", {
    almacen_id: s.almA, motivo: "Inventario inicial", origen: "inventario_inicial", idempotency_key: key(),
    partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.m2, cantidad: 100 }],
  });
}, 240_000);
afterAll(async () => { await stopDb(); });

// 10 cajas x 360 = 3600 (precios con IVA incluido); 30 % = 1080
const apartado = (pagos: unknown[], over: Record<string, unknown> = {}) => ({
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, cliente_id: s.cliente,
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 10, precio_unitario: 360 }],
  pagos, ...over,
});
const disponible = async () => {
  const r = await q(`select cantidad - apartado d, apartado from existencias where producto_id=$1 and almacen_id=$2`, [s.piso.id, s.almA]);
  return { disponible: Number(r[0].d), apartado: Number(r[0].apartado) };
};

describe("Apartados", () => {
  it("exige cliente registrado y anticipo mínimo de 30 %", async () => {
    await expect(rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "efectivo", importe: 1000 }]))).rejects.toThrow(/anticipo mínimo es 1080/);
    await expect(rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "efectivo", importe: 1080 }], { cliente_id: null })))
      .rejects.toThrow(/cliente registrado/);
  });

  it("apartar NO descuenta inventario: lo reserva y reduce el disponible", async () => {
    const antes = await stock(s.piso.id, s.almA);
    const a = await rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "efectivo", importe: 1080 }]));
    expect(Number(a.saldo)).toBe(2520);
    expect(await stock(s.piso.id, s.almA)).toBe(antes);
    expect((await disponible()).apartado).toBeCloseTo(14.4, 6);
    const movs = await q(`select count(*)::int n from movimientos where documento_id = $1`, [a.apartado_id]);
    expect(movs[0].n).toBe(0);
  });

  it("abonos: nunca más que el saldo; al liquidar se convierte en venta, descuenta y libera la reserva", async () => {
    const a = await rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "transferencia", importe: 1500, referencia: "TRF-1" }]));
    await expect(rpc(s.cajeroA, "abonar_apartado", { apartado_id: a.apartado_id, forma: "efectivo", importe: 5000, idempotency_key: key() }))
      .rejects.toThrow(/no mayor al saldo/);
    const k = key();
    await rpc(s.cajeroA, "abonar_apartado", { apartado_id: a.apartado_id, forma: "efectivo", importe: 1000, idempotency_key: k });
    await rpc(s.cajeroA, "abonar_apartado", { apartado_id: a.apartado_id, forma: "efectivo", importe: 1000, idempotency_key: k }); // doble clic
    expect(Number((await q(`select abonado from apartados where id=$1`, [a.apartado_id]))[0].abonado)).toBe(2500);

    const antesStock = await stock(s.piso.id, s.almA);
    const antesApartado = (await disponible()).apartado;
    const prep = await asUser(s.cajeroA, async (c) => (await c.query(`select preparar_liquidacion($1) r`, [a.apartado_id])).rows[0].r);
    // Aunque la lista cambie de precio, se respeta el precio apartado
    await q(`update precios set precio = 400 where unidad_venta_id = $1`, [s.piso.caja]);
    const v = await rpc(s.cajeroA, "confirmar_venta", {
      idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, cliente_id: s.cliente, apartado_id: a.apartado_id,
      partidas: prep.partidas, pagos: [{ forma: "anticipo", importe: prep.abonado }, { forma: "efectivo", importe: 1100 }],
    });
    await q(`update precios set precio = 360 where unidad_venta_id = $1`, [s.piso.caja]);
    expect(Number(v.total)).toBe(3600);
    expect(Number(v.cambio)).toBe(0);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antesStock - 14.4, 6);
    expect((await disponible()).apartado).toBeCloseTo(antesApartado - 14.4, 6);
    expect((await q(`select estado, venta_id from apartados where id=$1`, [a.apartado_id]))[0]).toEqual({ estado: "liquidado", venta_id: v.venta_id });
    // No se liquida dos veces
    await expect(rpc(s.cajeroA, "confirmar_venta", {
      idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, cliente_id: s.cliente, apartado_id: a.apartado_id,
      partidas: prep.partidas, pagos: [{ forma: "anticipo", importe: prep.abonado }, { forma: "efectivo", importe: 1100 }],
    })).rejects.toThrow(/liquidado/);
  });

  it("la forma 'anticipo' solo sirve para liquidar un apartado y por el monto exacto", async () => {
    await expect(rpc(s.cajeroA, "confirmar_venta", {
      idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }],
      pagos: [{ forma: "anticipo", importe: 360 }],
    })).rejects.toThrow(/solo aplica al liquidar/);
  });

  it("cancelar requiere permiso, libera la reserva y retiene el 10 % configurado (no más)", async () => {
    const a = await rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "efectivo", importe: 2000 }]));
    const reservado = (await disponible()).apartado;
    await expect(asUser(s.cajeroA, (c) => c.query(`select cancelar_apartado($1, 'Ya no lo quiere')`, [a.apartado_id])))
      .rejects.toThrow(/permiso/);
    await expect(asUser(s.admin, (c) => c.query(`select cancelar_apartado($1, 'x', 'efectivo', 50)`, [a.apartado_id])))
      .rejects.toThrow(/no puede ser mayor a 10/);
    const r = await asUser(s.admin, async (c) => (await c.query(`select cancelar_apartado($1, 'Ya no lo quiere') r`, [a.apartado_id])).rows[0].r);
    expect(r).toEqual({ retenido: 200, devuelto: 1800, porcentaje: 10 });
    expect((await disponible()).apartado).toBeCloseTo(reservado - 14.4, 6);
    const dev = await q(`select importe from apartado_pagos where apartado_id=$1 and tipo='devolucion'`, [a.apartado_id]);
    expect(Number(dev[0].importe)).toBe(1800);
  });

  it("avisa cuando un apartado lleva 30 días o más abierto", async () => {
    const a = await rpc(s.cajeroA, "crear_apartado", apartado([{ forma: "efectivo", importe: 1080 }]));
    expect((await q(`select requiere_aviso from v_apartados where id=$1`, [a.apartado_id]))[0].requiere_aviso).toBe(false);
    await q(`update apartados set fecha = now() - interval '31 days' where id=$1`, [a.apartado_id]);
    expect((await q(`select requiere_aviso from v_apartados where id=$1`, [a.apartado_id]))[0].requiere_aviso).toBe(true);
  });
});
