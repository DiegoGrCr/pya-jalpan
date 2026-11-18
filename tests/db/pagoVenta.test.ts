/** Registrar pago (abono) a una venta con saldo. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
let ventaId: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  const cl = (await q(`insert into clientes (nombre, limite_credito, dias_credito) values ('Cliente Crédito Ejemplo', 100000, 30) returning id`))[0].id;
  const r = await rpc(s.admin, "confirmar_venta", {
    idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "credito", cliente_id: cl,
    partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], pagos: [],
  });
  ventaId = r.venta_id;
}, 180_000);
afterAll(async () => { await stopDb(); });

describe("registrar_pago_venta", () => {
  it("abona, baja el saldo y no permite pagar de más", async () => {
    const k = key();
    const r = await rpc(s.cajeroA, "registrar_pago_venta", { idempotency_key: k, venta_id: ventaId, forma: "transferencia", importe: 100, referencia: "REF-1" });
    expect(Number(r.saldo)).toBe(260);
    const otra = await rpc(s.cajeroA, "registrar_pago_venta", { idempotency_key: k, venta_id: ventaId, forma: "transferencia", importe: 100 });
    expect(otra.repetida).toBe(true);   // reintento no duplica
    await expect(rpc(s.cajeroA, "registrar_pago_venta", { idempotency_key: key(), venta_id: ventaId, forma: "efectivo", importe: 300 }))
      .rejects.toThrow(/excede el saldo/);
    const [v] = await q(`select pagado::text, saldo::text from ventas where id = $1`, [ventaId]);
    expect(v).toEqual({ pagado: "100.00", saldo: "260.00" });
  });
});

describe("Contado con abono", () => {
  it("guarda con abono parcial, deja saldo y luego se liquida con registrar pago", async () => {
    const cl = (await q(`insert into clientes (nombre) values ('Cliente Abono Ejemplo') returning id`))[0].id;
    const base = { sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado", pago_pendiente: true, cliente_id: cl,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360, entregar_ahora: false }] };
    const r = await rpc(s.cajeroA, "confirmar_venta", { ...base, idempotency_key: key(), pagos: [{ forma: "efectivo", importe: 100 }] });
    const [v] = await q(`select pagado::text, saldo::text, con_abono, vencimiento from ventas where id = $1`, [r.venta_id]);
    expect(v).toEqual({ pagado: "100.00", saldo: "260.00", con_abono: true, vencimiento: null });
    const p = await rpc(s.cajeroA, "registrar_pago_venta", { idempotency_key: key(), venta_id: r.venta_id, forma: "efectivo", importe: 260 });
    expect(Number(p.saldo)).toBe(0);
    // Sin cliente registrado no se permite dejar saldo
    await expect(rpc(s.cajeroA, "confirmar_venta", { ...base, cliente_id: null, idempotency_key: key(), pagos: [] }))
      .rejects.toThrow(/cliente/);
  });
});
