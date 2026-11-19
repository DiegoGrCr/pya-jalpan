/** 0039: corte de caja semanal con retiros y dos totales (general y efectivo). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const venta = (pagos: object[], total = 720) => rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: total / 360, precio_unitario: 360 }], pagos });

describe("corte de caja", () => {
  it("suma por forma, resta retiros del efectivo y cierra con diferencia", async () => {
    const antes = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    await venta([{ forma: "efectivo", importe: 1000 }]);             // 720 en efectivo (cambio 280)
    await venta([{ forma: "tarjeta_debito", importe: 720 }]);
    await venta([{ forma: "efectivo", importe: 360 }, { forma: "transferencia", importe: 360 }]);
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, importe: 500, concepto: "Retiro para depósito" });
    const r = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    expect(Number(r.total_general) - Number(antes.total_general)).toBe(2160);
    expect(Number(r.efectivo_esperado) - Number(antes.efectivo_esperado)).toBe(720 + 360 - 500);
    expect(Number(r.retirado)).toBe(500);
    const c = await rpc(s.cajeroA, "cerrar_corte", { idempotency_key: key(), sucursal_id: s.sucA, efectivo_contado: Number(r.efectivo_esperado) - 10 });
    expect(c.serie).toBeTruthy();
    const nuevo = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    expect(Number(nuevo.total_general)).toBe(0);
    expect(nuevo.retiros).toHaveLength(0);
  });
});

describe("gastos", () => {
  it("un gasto en efectivo baja la caja; por transferencia solo cuenta como gasto", async () => {
    const a = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, tipo: "gasto", importe: 200, concepto: "Flete", categoria: "Fletes y transporte" });
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, tipo: "gasto", importe: 300, concepto: "Luz", categoria: "Luz y agua", forma: "transferencia" });
    const b = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    expect(Number(b.efectivo_esperado)).toBe(Number(a.efectivo_esperado) - 200);
    expect(Number(b.gastado)).toBe(Number(a.gastado ?? 0) + 500);
    expect(Number(b.neto)).toBe(Number(b.total_general) - Number(b.gastado));
    await expect(rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, tipo: "gasto", importe: 10, concepto: "X" })).rejects.toThrow(/categoría/);
    const t = await rpc(s.cajeroA, "tablero", {});
    expect(Number(t.periodo.gastos)).toBeGreaterThanOrEqual(500);
  });
});

describe("ventas del corte", () => {
  it("lista cada venta del periodo con lo cobrado por forma; las canceladas en cero", async () => {
    const v1 = await venta([{ forma: "efectivo", importe: 360 }, { forma: "tarjeta_credito", importe: 360 }]);
    const v2 = await venta([{ forma: "efectivo", importe: 720 }]);
    await asUser(s.cajeroA, (c) => c.query(`select public.cancelar_venta($1, 'Prueba')`, [v2.venta_id]));
    const r = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    const a = r.ventas.find((x: { id: string }) => x.id === v1.venta_id);
    expect(Number(a.pagos.efectivo)).toBe(360);
    expect(Number(a.pagos.tarjeta_credito)).toBe(360);
    expect(a.anterior).toBe(false);
    const b = r.ventas.find((x: { id: string }) => x.id === v2.venta_id);
    expect(b.estado).toBe("cancelada");
    expect(b.pagos).toEqual({});
  });
});
