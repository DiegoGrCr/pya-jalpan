/** 0032: consulta de existencias por producto y almacén. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, asUser, stock, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });
const consulta = (p: object) => asUser(s.cajeroA, async (c) => (await c.query(`select * from public.existencias_consulta($1::jsonb)`, [JSON.stringify(p)])).rows);

describe("existencias_consulta", () => {
  it("total por producto, por almacén y filtros", async () => {
    const todas = await consulta({ texto: "Ficticio" });
    const piso = todas.find((r) => r.producto_id === s.piso.id);
    expect(Number(piso.total)).toBeCloseTo((await stock(s.piso.id, s.almA)) + (await stock(s.piso.id, s.almB)), 6);
    const soloA = await consulta({ texto: "Ficticio", almacen_id: s.almA });
    expect(Number(soloA.find((r) => r.producto_id === s.piso.id).total)).toBeCloseTo(await stock(s.piso.id, s.almA), 6);
    expect((await consulta({ filtro: "negativa" })).every((r) => Number(r.total) < 0)).toBe(true);
    expect(Number(todas[0].total_filas)).toBe(todas.length);
  });
});
