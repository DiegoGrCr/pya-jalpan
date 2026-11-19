/** Cuadre del corte (datos ficticios). */
import { describe, it, expect } from "vitest";
import { cuadreEfectivo, totalesVentas, estatusCorte, htmlCorte, type Resumen, type VentaCorte } from "@/lib/corteCaja";

const v = (x: Partial<VentaCorte>): VentaCorte => ({ id: crypto.randomUUID(), serie: "AR", folio: 1, fecha: "2026-11-10T18:00:00Z", tipo: "contado",
  estado: "confirmada", cliente: "Público en General", total: 100, saldo: 0, anterior: false, pagos: {}, ...x });

const r: Resumen = {
  desde: "2026-11-09T06:00:00Z", hasta: "2026-11-15T23:00:00Z",
  entradas: [{ concepto: "Ventas y pagos", forma: "efectivo", importe: 1000 }, { concepto: "Ventas y pagos", forma: "tarjeta_debito", importe: 500 }],
  salidas: [{ concepto: "Devoluciones de ventas", forma: "efectivo", importe: 50 }],
  retiros: [{ id: "r1", fecha: "2026-11-12T18:00:00Z", importe: 600, concepto: "Depósito", usuario: null }],
  gastos: [{ id: "g1", fecha: "2026-11-12T18:00:00Z", importe: 30, concepto: "Agua", categoria: "Otros", forma: "efectivo", proveedor: null, usuario: null },
           { id: "g2", fecha: "2026-11-12T18:00:00Z", importe: 200, concepto: "Luz", categoria: "Luz y agua", forma: "transferencia", proveedor: null, usuario: null }],
  retirado: 600, gastado: 230, gastado_efectivo: 30, neto: 1220,
  total_general: 1450, efectivo_esperado: 1000 - 50 - 600 - 30, por_forma: { efectivo: 950, tarjeta_debito: 500 },
  ventas: [
    v({ folio: 3, total: 1000, pagos: { efectivo: 1000 } }),
    v({ folio: 2, total: 800, saldo: 300, pagos: { tarjeta_debito: 500 } }),
    v({ folio: 1, estado: "cancelada", total: 400 }),
  ],
};

describe("corte de caja", () => {
  it("el cuadre suma al efectivo esperado y termina en lo contado", () => {
    const l = cuadreEfectivo(r, 300);
    const signo = (x: (typeof l)[number]) => (x.signo === "+" ? 1 : x.signo === "−" ? -1 : 0);
    const esperado = l.find((x) => x.texto === "Efectivo esperado en caja")!;
    expect(l.slice(0, l.indexOf(esperado)).reduce((s, x) => s + signo(x) * x.importe, 0)).toBe(esperado.importe);
    expect(l.find((x) => x.signo === "±")!.importe).toBe(300 - 320);
    expect(l.at(-1)).toMatchObject({ texto: "En caja (contado)", importe: 300 });
    expect(l.some((x) => x.texto === "Luz")).toBe(false);   // por transferencia no sale de la caja
  });
  it("totales de ventas excluyen canceladas", () => {
    const t = totalesVentas(r.ventas!);
    expect(t).toMatchObject({ efectivo: 1000, tarjeta: 500, total: 1800, porCobrar: 300, num: 2, canceladas: 1 });
    expect(r.ventas!.map(estatusCorte)).toEqual(["Pagada", "Por cobrar", "Cancelada"]);
    expect(htmlCorte(r, { titulo: "Corte", sucursal: "PV - Ejemplo" })).toContain("Cuadre de efectivo");
  });
});
