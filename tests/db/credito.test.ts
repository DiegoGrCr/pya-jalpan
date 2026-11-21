/** Crédito del cliente: quién lo cambia, vencimiento de la nota y reglas al vender a crédito. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, q, key, asUser, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

/** Venta a crédito de N cajas a $360 (precio de lista), sin entregar */
const venta = (usuario: string, cliente: string, cajas: number) => rpc(usuario, "confirmar_venta", {
  idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA, tipo: "credito", cliente_id: cliente,
  partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: cajas, precio_unitario: 360, entregar_ahora: false }], pagos: [],
});
const editarCredito = (usuario: string, cliente: string, campos: string) =>
  asUser(usuario, (c) => c.query(`update clientes set ${campos} where id = $1`, [cliente]));

describe("crédito del cliente", () => {
  it("un cajero no puede cambiar días, límite ni bloqueo; un administrador sí y queda en bitácora", async () => {
    const cl = (await q(`insert into clientes (nombre) values ('Cliente Crédito Ficticio') returning id`))[0].id;
    await expect(editarCredito(s.cajeroA, cl, "dias_credito = 15")).rejects.toThrow(/permiso para modificar el crédito/);
    await expect(editarCredito(s.cajeroA, cl, "limite_credito = 5000")).rejects.toThrow(/permiso/);
    await expect(editarCredito(s.cajeroA, cl, "bloqueado = true")).rejects.toThrow(/permiso/);
    await editarCredito(s.cajeroA, cl, "telefono = '4410000000'");                         // otros datos sí
    await editarCredito(s.admin, cl, "dias_credito = 15, limite_credito = 5000");
    const [c] = await q(`select dias_credito, limite_credito::text from clientes where id = $1`, [cl]);
    expect(c).toEqual({ dias_credito: 15, limite_credito: "5000.00" });
    const [b] = await q(`select count(*)::int n from bitacora where entidad = 'clientes' and entidad_id = $1::text`, [cl]);
    expect(b.n).toBeGreaterThan(0);
  });

  it("la nota a crédito vence a los días de crédito del cliente", async () => {
    const r = await venta(s.cajeroA, s.clienteCredito, 1);   // 30 días, límite 10,000
    const [v] = await q(`select vencimiento = (now() at time zone 'America/Mexico_City')::date + 30 as ok from ventas where id = $1`, [r.venta_id]);
    expect(v.ok).toBe(true);
  });

  it("el cajero no pasa del límite, ni con saldo vencido, ni bloqueado; el administrador sí lo autoriza", async () => {
    const cl = (await q(`insert into clientes (nombre, limite_credito, dias_credito) values ('Cliente Límite Ficticio', 2000, 30) returning id`))[0].id;
    await venta(s.cajeroA, cl, 4);                                                           // $1,440
    await expect(venta(s.cajeroA, cl, 2)).rejects.toThrow(/límite/i);                       // $2,160 > $2,000
    await venta(s.admin, cl, 2);                                                          // autorizada

    await q(`update ventas set vencimiento = current_date - 1 where cliente_id = $1`, [cl]);
    await q(`update clientes set limite_credito = 100000 where id = $1`, [cl]);
    await expect(venta(s.cajeroA, cl, 1)).rejects.toThrow(/vencido/);

    await q(`update ventas set vencimiento = current_date + 30 where cliente_id = $1`, [cl]);
    await q(`update clientes set bloqueado = true where id = $1`, [cl]);
    await expect(venta(s.cajeroA, cl, 1)).rejects.toThrow(/bloqueado/);
    await venta(s.admin, cl, 1);
  });
});
