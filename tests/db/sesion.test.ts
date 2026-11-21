/** 0049: una sola sesión abierta por usuario. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("sesión única", () => {
  it("un segundo equipo no puede entrar mientras el primero sigue vivo; al salir ya puede", async () => {
    const a = key(), b = key();
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: a, equipo: "Chrome en Windows" })).estado).toBe("ok");
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: a })).estado).toBe("ok");          // latido del mismo
    const r = await rpc(s.cajeroA, "tomar_sesion", { sesion: b, equipo: "Safari en iPhone" });
    expect(r.estado).toBe("ocupada");
    expect(r.equipo).toBe("Chrome en Windows");
    // Otro usuario no se ve afectado
    expect((await rpc(s.admin, "tomar_sesion", { sesion: key() })).estado).toBe("ok");

    await rpc(s.cajeroA, "dejar_sesion", { sesion: a });
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: b })).estado).toBe("ok");
    // El primero ya no recupera la sesión
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: a })).estado).toBe("ocupada");
    await rpc(s.cajeroA, "dejar_sesion", { sesion: b });
  });

  it("si el equipo se apagó sin salir, la sesión caduca a los 3 minutos", async () => {
    const a = key(), b = key();
    await rpc(s.cajeroA, "tomar_sesion", { sesion: a });
    await q(`update sesiones_activas set ultima_actividad = now() - interval '4 minutes' where user_id = $1`, [s.cajeroA]);
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: b })).estado).toBe("ok");
    await rpc(s.cajeroA, "dejar_sesion", { sesion: b });
  });

  it("dejar_sesion con otro identificador no libera la sesión ajena", async () => {
    const a = key();
    await rpc(s.cajeroA, "tomar_sesion", { sesion: a });
    await rpc(s.cajeroA, "dejar_sesion", { sesion: key() });
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: key() })).estado).toBe("ocupada");
    await rpc(s.cajeroA, "dejar_sesion", { sesion: a });
  });

  it("el administrador cierra la sesión: el equipo viejo queda fuera y se puede entrar desde otro", async () => {
    const a = key();
    await rpc(s.cajeroA, "tomar_sesion", { sesion: a });
    await expect(rpc(s.cajeroB, "cerrar_sesion_usuario", { user_id: s.cajeroA })).rejects.toThrow(/administrador/);
    await rpc(s.admin, "cerrar_sesion_usuario", { user_id: s.cajeroA });
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: a })).estado).toBe("revocada");
    expect((await rpc(s.cajeroA, "tomar_sesion", { sesion: key() })).estado).toBe("ok");
  });

  it("los usuarios no pueden escribir la tabla directamente ni ver la de otros", async () => {
    await expect(rpc(s.cajeroA, "tomar_sesion", { sesion: "" })).rejects.toThrow(/identificador/);
    await expect(asUser(s.cajeroA, (c) => c.query(`update sesiones_activas set sesion_id = null`))).rejects.toThrow(/permission denied/);
    const propias = await asUser(s.cajeroA, (c) => c.query(`select user_id from sesiones_activas`));
    expect(propias.rows.map((x) => x.user_id)).toEqual([s.cajeroA]);
    const todas = await asUser(s.admin, (c) => c.query(`select user_id from sesiones_activas`));
    expect(todas.rows.length).toBeGreaterThan(1);
  });
});
