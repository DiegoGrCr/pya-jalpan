/** 0036: color de interfaz por usuario. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

describe("cambiar_tema_usuario", () => {
  it("el administrador pone morado a un usuario; un vendedor no puede", async () => {
    await rpc(s.admin, "cambiar_tema_usuario", { user_id: s.cajeroA, tema: "morado" });
    expect((await q(`select tema from perfiles where user_id = $1`, [s.cajeroA]))[0].tema).toBe("morado");
    await rpc(s.admin, "cambiar_tema_usuario", { user_id: s.cajeroA, tema: "" });
    expect((await q(`select tema from perfiles where user_id = $1`, [s.cajeroA]))[0].tema).toBeNull();
    await expect(rpc(s.cajeroA, "cambiar_tema_usuario", { user_id: s.cajeroA, tema: "morado" })).rejects.toThrow(/administrador/);
  });
});
