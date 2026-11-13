/** Configuración › Usuarios: guardar_usuario (perfil, rol, sucursales, estado). */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, Seed } from "./setup";

let s: Seed;
let nuevo: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  nuevo = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'sucursal2@usuarios.local') returning id`))[0].id;
}, 180_000);
afterAll(async () => { await stopDb(); });

describe("guardar_usuario", () => {
  it("el administrador da de alta el perfil con usuario y sucursal", async () => {
    await rpc(s.admin, "guardar_usuario", { user_id: nuevo, usuario: "Sucursal2", nombre: "Mostrador 2", rol: "cajero", sucursales: [s.sucB] });
    const [p] = await q(`select usuario, nombre, rol, activo from perfiles where user_id = $1`, [nuevo]);
    expect(p).toEqual({ usuario: "sucursal2", nombre: "Mostrador 2", rol: "cajero", activo: true });
    expect(await q(`select sucursal_id from usuario_sucursales where user_id = $1`, [nuevo])).toEqual([{ sucursal_id: s.sucB }]);
  });
  it("cambia sucursales, rol y estado; deja registro en la bitácora con el administrador", async () => {
    await rpc(s.admin, "guardar_usuario", { user_id: nuevo, rol: "gerente", sucursales: [s.sucA], activo: false });
    const [p] = await q(`select rol, activo from perfiles where user_id = $1`, [nuevo]);
    expect(p).toEqual({ rol: "gerente", activo: false });
    expect(await q(`select sucursal_id from usuario_sucursales where user_id = $1`, [nuevo])).toEqual([{ sucursal_id: s.sucA }]);
    const [b] = await q(`select user_id from bitacora where entidad = 'perfiles' and entidad_id = $1 order by id desc limit 1`, [nuevo]);
    expect(b.user_id).toBe(s.admin);
  });
  it("exige al menos una sucursal si no es administrador", async () => {
    await expect(rpc(s.admin, "guardar_usuario", { user_id: nuevo, sucursales: [] })).rejects.toThrow(/al menos una sucursal/);
  });
  it("un cajero no puede administrar usuarios", async () => {
    await expect(rpc(s.cajeroA, "guardar_usuario", { user_id: nuevo, activo: true })).rejects.toThrow(/administrador/);
  });
  it("el administrador no puede desactivarse ni quitarse el rol", async () => {
    await expect(rpc(s.admin, "guardar_usuario", { user_id: s.admin, activo: false })).rejects.toThrow(/a ti mismo/);
    await expect(rpc(s.admin, "guardar_usuario", { user_id: s.admin, rol: "cajero" })).rejects.toThrow(/a ti mismo/);
  });
  it("rechaza usuario con formato inválido", async () => {
    const otro = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'x@usuarios.local') returning id`))[0].id;
    await expect(rpc(s.admin, "guardar_usuario", { user_id: otro, usuario: "con espacio", nombre: "X", rol: "cajero", sucursales: [s.sucA] })).rejects.toThrow();
  });
});
