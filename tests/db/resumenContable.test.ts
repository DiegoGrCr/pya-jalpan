/** 0054: resumen contable del periodo por sucursal. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
let conta: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  conta = randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'conta@ejemplo.test')`, [conta]);
  await q(`insert into perfiles (user_id, nombre, rol) values ($1, 'Contadora Ficticia', 'facturacion')`, [conta]);
}, 180_000);
afterAll(async () => { await stopDb(); });

const caja = (n: number) => [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: n, precio_unitario: 360 }];
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

describe("resumen_contable", () => {
  it("suma ventas, cobranza por forma, devoluciones, gastos y por cobrar por sucursal", async () => {
    await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, partidas: caja(2), pagos: [{ forma: "efectivo", importe: 720 }] });
    const v2 = await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, partidas: caja(1), pagos: [{ forma: "tarjeta_debito", importe: 360 }] });
    await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "credito", cliente_id: s.clienteCredito, partidas: caja(3), pagos: [] });
    await rpc(s.cajeroA, "devolver_productos", { idempotency_key: key(), venta_id: v2.venta_id, motivo: "Le sobró", destino: "dinero", forma: "tarjeta_debito",
      partidas: [{ partida_id: (await q(`select id from venta_partidas where venta_id = $1`, [v2.venta_id]))[0].id, cantidad: 1 }] });
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, importe: 150, concepto: "Flete ficticio", tipo: "gasto", categoria: "Fletes", forma: "efectivo" });
    await rpc(s.cajeroB, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucB, almacen_id: s.almB, partidas: caja(1), pagos: [{ forma: "transferencia", importe: 360 }] });

    const r = await rpc(conta, "resumen_contable", { desde: hoy(), hasta: hoy() });
    expect(r.costos).toBe(true);
    const cen = r.sucursales.find((x: { codigo: string }) => x.codigo === "CEN");
    const nte = r.sucursales.find((x: { codigo: string }) => x.codigo === "NTE");
    expect(cen.ventas.num).toBe(3);
    expect(Number(cen.ventas.total)).toBe(2160);
    expect(Number(cen.ventas.credito)).toBe(1080);
    expect(Number(cen.cobranza.efectivo)).toBe(720);
    expect(Number(cen.cobranza.tarjeta_debito)).toBe(360);
    expect(Number(cen.devoluciones.dinero.tarjeta_debito)).toBe(360);
    expect(Number(cen.gastos.total)).toBe(150);
    expect(cen.gastos.categorias[0]).toMatchObject({ categoria: "Fletes" });
    expect(Number(cen.por_cobrar.saldo)).toBe(1080);
    expect(Number(cen.costo)).toBeCloseTo(5 * 1.44 * 150, 2);   // sin la caja devuelta
    expect(Number(cen.ventas_netas)).toBe(1800);
    expect(Number(cen.utilidad)).toBeCloseTo(1800 - 5 * 1.44 * 150, 2);
    expect(Number(nte.cobranza.transferencia)).toBe(360);
  });

  it("el cajero solo ve su sucursal y sin costos", async () => {
    const r = await rpc(s.cajeroA, "resumen_contable", { desde: hoy(), hasta: hoy() });
    expect(r.sucursales.map((x: { codigo: string }) => x.codigo)).toEqual(["CEN"]);
    expect(r.costos).toBe(false);
    expect(r.sucursales[0].costo).toBeNull();
  });
});
