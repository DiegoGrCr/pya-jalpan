/** Scripts de configuración inicial/demo y alta de sucursales desde el sistema. */
import { beforeAll, afterAll, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startDb, stopDb, q, pool, rpc, key } from "./setup";

let admin: string;

beforeAll(async () => { await startDb(); }, 240_000);
afterAll(async () => { await stopDb(); });

it("01_configuracion_inicial y 02_datos_demo dejan la sucursal principal lista para vender", async () => {
  admin = (await q(`insert into auth.users (id, email) values (gen_random_uuid(), 'admin@ejemplo.com') returning id`))[0].id;
  for (const f of ["01_configuracion_inicial.sql", "02_datos_demo.sql"]) {
    await pool.query(readFileSync(join(process.cwd(), "supabase", "seed", f), "utf8"));
  }
  expect(await q(`select codigo, nombre from sucursales`)).toEqual([{ codigo: "P", nombre: "PRINCIPAL" }]);
  expect((await q(`select count(*)::int n from series`))[0].n).toBe(14);
  expect((await q(`select prefijo from series where tipo_documento = 'venta'`))[0].prefijo).toBe("PV");
  expect((await q(`select count(*)::int n from usuario_sucursales`))[0].n).toBe(1);
  expect(Number((await q(`select sum(cantidad)::numeric s from existencias`))[0].s)).toBe(200);
  expect((await q(`select count(*)::int n from movimientos where tipo = 'inventario_inicial'`))[0].n).toBe(2);
});

it("el administrador crea una sucursal nueva con almacén, caja y series; puede vender en ella", async () => {
  const r = await rpc(admin, "crear_sucursal", { codigo: "n2", nombre: "Sucursal Nueva", cp_expedicion: "76000" });
  expect(r.codigo).toBe("N2");
  expect((await q(`select count(*)::int n from series where sucursal_id = $1`, [r.sucursal_id]))[0].n).toBe(14);
  expect((await q(`select count(*)::int n from cajas where sucursal_id = $1`, [r.sucursal_id]))[0].n).toBe(1);
  expect((await q(`select count(*)::int n from usuario_sucursales where sucursal_id = $1`, [r.sucursal_id]))[0].n).toBe(1);
  const unidad = (await q(`select u.id, u.producto_id from unidades_venta u join productos p on p.id = u.producto_id
                            where p.sku = 'DEMO-001' and u.nombre = 'CAJA'`))[0];
  const v = await rpc(admin, "confirmar_venta", {
    idempotency_key: key(), sucursal_id: r.sucursal_id, almacen_id: r.almacen_id, tipo: "contado",
    partidas: [{ producto_id: unidad.producto_id, unidad_venta_id: unidad.id, cantidad: 1, precio_unitario: 360 }],
    pagos: [{ forma: "efectivo", importe: 500 }],
  });
  expect(v.serie).toBe("N2V");
  expect(Number(v.folio)).toBe(1);
});

it("rechaza códigos duplicados o inválidos y a usuarios sin permiso", async () => {
  await expect(rpc(admin, "crear_sucursal", { codigo: "P", nombre: "Otra" })).rejects.toThrow(/Ya existe/);
  await expect(rpc(admin, "crear_sucursal", { codigo: "MUY-LARGO", nombre: "X" })).rejects.toThrow(/código/);
  const cajero = randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'cajero@ejemplo.test')`, [cajero]);
  await q(`insert into perfiles (user_id, nombre, rol) values ($1, 'Cajero', 'cajero')`, [cajero]);
  await expect(rpc(cajero, "crear_sucursal", { codigo: "Z9", nombre: "No" })).rejects.toThrow(/propietario/);
});
