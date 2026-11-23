/** 0058: gastos con o sin factura. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });

describe("gastos con factura", () => {
  it("guarda la marca y el folio, y el resumen contable separa lo deducible", async () => {
    const g = await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, importe: 300, concepto: "Papelería ficticia", tipo: "gasto",
      categoria: "Papelería", forma: "efectivo", con_factura: true, factura_folio: "abcd-1234" });
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, importe: 50, concepto: "Agua", tipo: "gasto", categoria: "Otros", forma: "efectivo" });
    // un retiro nunca lleva factura
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, importe: 100, concepto: "Depósito", con_factura: true });
    expect((await q(`select con_factura, factura_folio from retiros_caja where id = $1`, [g.retiro_id]))[0]).toEqual({ con_factura: true, factura_folio: "ABCD-1234" });
    expect((await q(`select count(*)::int n from retiros_caja where tipo = 'retiro' and con_factura`))[0].n).toBe(0);
    const r = await rpc(s.admin, "resumen_contable", { desde: hoy(), hasta: hoy(), sucursal_id: s.sucA });
    expect(Number(r.sucursales[0].gastos.con_factura)).toBe(300);
    expect(Number(r.sucursales[0].gastos.total)).toBe(350);
  });
});
