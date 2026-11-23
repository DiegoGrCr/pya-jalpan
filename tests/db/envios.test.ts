/** 0059: agenda de envíos. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { startDb, stopDb, seed, rpc, q, key, asUser, Seed } from "./setup";

let s: Seed;
let conta: string;
beforeAll(async () => {
  await startDb(); s = await seed();
  conta = randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'conta2@ejemplo.test')`, [conta]);
  await q(`insert into perfiles (user_id, nombre, rol) values ($1, 'Contadora Ficticia', 'facturacion')`, [conta]);
}, 180_000);
afterAll(async () => { await stopDb(); });

const venta = (u: string, suc: string, alm: string) => rpc(u, "confirmar_venta", { idempotency_key: key(), sucursal_id: suc, almacen_id: alm, cliente_id: s.clienteCredito,
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360, entregar_ahora: false }], pagos: [{ forma: "efectivo", importe: 720 }] });

describe("agenda de envíos", () => {
  it("se agenda con varias notas; todos lo ven con sus notas, aunque sean de otra sucursal", async () => {
    const a = await venta(s.cajeroA, s.sucA, s.almA), b = await venta(s.cajeroA, s.sucA, s.almA);
    const r = await rpc(s.cajeroA, "guardar_envio", { idempotency_key: key(), fecha: "2026-12-01", hora: "9:00", destino: "Pinal de Amoles", prioridad: "alta",
      sucursal_id: s.sucA, ventas: [a.venta_id, b.venta_id] });
    expect(r.numero).toBeGreaterThan(0);
    const e = (await q(`select cliente_id, creado_por, prioridad from envios where id = $1`, [r.envio_id]))[0];
    expect(e).toEqual({ cliente_id: s.clienteCredito, creado_por: s.cajeroA, prioridad: "alta" });
    // el cajero de otra sucursal lo ve con sus notas (y que falta entregar material)
    const notas = await asUser(s.cajeroB, async (c) => (await c.query(`select * from envio_notas($1)`, [[r.envio_id]])).rows);
    expect(notas.length).toBe(2);
    expect(notas[0].por_entregar).toBe(true);
    expect((await asUser(conta, async (c) => (await c.query(`select id from envios`)).rows)).length).toBe(1);
  });

  it("solo viaje (sin notas) necesita describir qué se lleva; cambia de estado y queda en historial", async () => {
    await expect(rpc(s.cajeroB, "guardar_envio", { idempotency_key: key(), fecha: "2026-12-02", destino: "Jalpan" })).rejects.toThrow(/Liga al menos una nota/);
    const r = await rpc(s.cajeroB, "guardar_envio", { idempotency_key: key(), fecha: "2026-12-02", destino: "Jalpan", contenido: "Recoger material en bodega" });
    await rpc(s.cajeroB, "cambiar_estado_envio", { envio_id: r.envio_id, estado: "en_ruta" });
    await rpc(s.cajeroA, "cambiar_estado_envio", { envio_id: r.envio_id, estado: "entregado", recibio: "Encargado de obra" });
    expect((await q(`select estado, recibio, entregado_por from envios where id = $1`, [r.envio_id]))[0]).toEqual({ estado: "entregado", recibio: "Encargado de obra", entregado_por: s.cajeroA });
    await expect(rpc(s.cajeroA, "guardar_envio", { id: r.envio_id, idempotency_key: key(), fecha: "2026-12-02", destino: "X", contenido: "y" })).rejects.toThrow(/ya no se edita/);
    await expect(rpc(s.cajeroA, "cambiar_estado_envio", { envio_id: r.envio_id, estado: "cancelado" })).rejects.toThrow(/motivo/);
    const h = await asUser(s.cajeroA, async (c) => (await c.query(`select accion from historial_envio($1)`, [r.envio_id])).rows);
    expect(h.map((x) => x.accion)).toEqual(["crear", "estado", "estado"]);
  });

  it("Contabilidad lo ve pero no agenda", async () => {
    await expect(rpc(conta, "guardar_envio", { idempotency_key: key(), fecha: "2026-12-03", destino: "Landa", contenido: "x" })).rejects.toThrow(/solo consulta/);
  });
});
