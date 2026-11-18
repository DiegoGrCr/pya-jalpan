/** 0029: almacén predeterminado, desactivar y eliminar almacenes. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("administrar almacenes", () => {
  it("el propietario crea, renombra, hace predeterminado y elimina un almacén sin uso", async () => {
    const id = await rpc(s.admin, "crear_almacen", { sucursal_id: s.sucA, nombre: "Bodega Ejemplo" });
    await rpc(s.admin, "actualizar_almacen", { id, nombre: "Bodega Ejemplo 2" });
    expect((await q(`select nombre from almacenes where id = $1`, [id]))[0].nombre).toBe("Bodega Ejemplo 2");
    await rpc(s.admin, "almacen_predeterminado", { sucursal_id: s.sucA, almacen_id: id });
    expect((await q(`select almacen_predeterminado_id a from sucursales where id = $1`, [s.sucA]))[0].a).toBe(id);
    const { asUser } = await import("./setup");
    await expect(asUser(s.admin, (c) => c.query(`select public.eliminar_almacen($1)`, [id]))).rejects.toThrow(/predeterminado/);
    await rpc(s.admin, "almacen_predeterminado", { sucursal_id: s.sucA, almacen_id: s.almA });
    await asUser(s.admin, (c) => c.query(`select public.eliminar_almacen($1)`, [id]));
    expect((await q(`select count(*)::int n from almacenes where id = $1`, [id]))[0].n).toBe(0);
  });

  it("no deja desactivar un almacén con existencia ni eliminar uno con movimientos", async () => {
    const { asUser } = await import("./setup");
    await expect(rpc(s.admin, "actualizar_almacen", { id: s.almB, activo: false })).rejects.toThrow(/predeterminado|existencia/);
    await expect(asUser(s.admin, (c) => c.query(`select public.eliminar_almacen($1)`, [s.almB]))).rejects.toThrow(/predeterminado|movimientos|existencia/);
  });

  it("un vendedor no puede administrar almacenes", async () => {
    await expect(rpc(s.cajeroA, "actualizar_almacen", { id: s.almA, nombre: "X" })).rejects.toThrow(/propietario/);
  });
});

describe("relación sucursales–almacenes", () => {
  it("la llave usada por la app para unir almacenes con su sucursal se llama almacenes_sucursal_id_fkey", async () => {
    const r = await q(`select conname from pg_constraint where conrelid = 'public.almacenes'::regclass and contype = 'f'`);
    expect(r.map((x) => x.conname)).toContain("almacenes_sucursal_id_fkey");
  });
});
