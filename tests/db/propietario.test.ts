/** Solo el propietario de la cuenta crea sucursales/almacenes y administra administradores. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, asUser, Seed } from "./setup";

let s: Seed;
let admin2: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  admin2 = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'otro@ejemplo.test') returning id`))[0].id;
  await q(`insert into perfiles (user_id, nombre, rol) values ($1, 'Otro admin', 'administrador')`, [admin2]);
}, 180_000);
afterAll(async () => { await stopDb(); });

describe("Propietario de la cuenta", () => {
  it("el propietario crea sucursal y almacén", async () => {
    const r = await rpc(s.admin, "crear_sucursal", { codigo: "S9", nombre: "NUEVA" });
    expect(r.codigo).toBe("S9");
    await rpc(s.admin, "crear_almacen", { sucursal_id: r.sucursal_id, nombre: "BODEGA 2" });
  });
  it("otro administrador no puede crear sucursales, almacenes ni desactivarlas", async () => {
    await expect(rpc(admin2, "crear_sucursal", { codigo: "S8", nombre: "X" })).rejects.toThrow(/propietario/);
    await expect(rpc(admin2, "crear_almacen", { sucursal_id: s.sucA, nombre: "X" })).rejects.toThrow(/propietario/);
    await expect(rpc(admin2, "actualizar_sucursal", { id: s.sucA, activa: false })).rejects.toThrow(/propietario/);
    await rpc(admin2, "actualizar_sucursal", { id: s.sucA, telefono: "0000000000" }); // datos sí puede
  });
  it("otro administrador no puede crear administradores ni tocar al propietario", async () => {
    await expect(rpc(admin2, "guardar_usuario", { user_id: s.cajeroA, rol: "administrador" })).rejects.toThrow(/propietario/);
    await expect(rpc(admin2, "guardar_usuario", { user_id: s.admin, nombre: "X" })).rejects.toThrow(/propietario/);
    await rpc(admin2, "guardar_usuario", { user_id: s.cajeroA, nombre: "Cajero editado" }); // cajeros sí
  });
  it("el propietario no se puede desactivar ni degradar", async () => {
    await expect(q(`update perfiles set activo = false where user_id = $1`, [s.admin])).rejects.toThrow(/propietario/);
    await expect(q(`update perfiles set propietario = true where user_id = $1`, [admin2])).rejects.toThrow();
  });
  it("es_propietario distingue a cada quien", async () => {
    const es = (u: string) => asUser(u, async (c) => (await c.query("select public.es_propietario() as r")).rows[0].r);
    expect(await es(s.admin)).toBe(true);
    expect(await es(admin2)).toBe(false);
    expect(await es(s.cajeroA)).toBe(false);
  });
});
