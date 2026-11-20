/** supabase/scripts/reiniciar_datos_prueba.sql: borra la operación y el catálogo, conserva la configuración. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { startDb, stopDb, seed, rpc, key, q, pool, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("reiniciar datos de prueba", () => {
  it("deja todo en cero menos la configuración y Público en General", async () => {
    const v = await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "contado",
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 1, precio_unitario: 360 }], pagos: [{ forma: "efectivo", importe: 360 }] });
    expect(v.venta_id).toBeTruthy();
    await rpc(s.cajeroA, "registrar_retiro", { idempotency_key: key(), sucursal_id: s.sucA, tipo: "gasto", categoria: "Otros", importe: 10, concepto: "Agua" });
    const r = await rpc(s.cajeroA, "corte_resumen", { sucursal_id: s.sucA });
    await rpc(s.cajeroA, "cerrar_corte", { idempotency_key: key(), sucursal_id: s.sucA, efectivo_contado: Number(r.efectivo_esperado) });
    const antes = (await q(`select count(*)::int n from sucursales`))[0].n;

    await pool.query(readFileSync("supabase/scripts/reiniciar_datos_prueba.sql", "utf8"));

    const [c] = await q(`select (select count(*) from ventas)::int ventas, (select count(*) from productos)::int productos,
      (select count(*) from movimientos)::int movimientos, (select count(*) from cortes_caja)::int cortes, (select count(*) from retiros_caja)::int retiros,
      (select count(*) from clientes)::int clientes, (select count(*) from clientes where es_publico_general)::int publico,
      (select count(*) from sucursales)::int sucursales, (select count(*) from almacenes)::int almacenes, (select max(siguiente))::int folio from series`);
    expect(c).toMatchObject({ ventas: 0, productos: 2, movimientos: 0, cortes: 0, retiros: 0, clientes: 1, publico: 1, sucursales: antes, folio: 1 });
    expect(c.almacenes).toBeGreaterThan(0);
  });
});
