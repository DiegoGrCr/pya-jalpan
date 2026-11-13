/**
 * Arnés de pruebas de base de datos.
 * Levanta un Postgres real embebido (sin Docker), crea un "shim" mínimo de Supabase
 * (esquema auth, auth.uid(), roles anon/authenticated) y aplica las migraciones de
 * supabase/migrations en orden. Las RPC se llaman como el rol `authenticated` con
 * el JWT simulado, igual que en Supabase, para que RLS y permisos apliquen de verdad.
 */
import EmbeddedPostgres from "embedded-postgres";
import { Pool, PoolClient } from "pg";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.TEST_PG_PORT ?? 54329);
const DATA_DIR = join(process.cwd(), ".pgdata-test");
const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

let pg: EmbeddedPostgres | null = null;
export let pool: Pool;

const SHIM = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), '')::uuid,
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid)
$$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated;
-- Igual que Supabase: privilegios predeterminados amplios sobre objetos nuevos de public.
-- La seguridad real debe venir de RLS y de revocar explícitamente en las migraciones.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated;
`;

export async function startDb(): Promise<void> {
  rmSync(DATA_DIR, { recursive: true, force: true });
  pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: (e) => { if (process.env.PG_LOG) console.error(e); },
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase("erp_test");
  pool = new Pool({
    host: "127.0.0.1", port: PORT, user: "postgres", password: "postgres",
    database: "erp_test", max: 20,
  });
  await pool.query(SHIM);
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    try {
      await pool.query(sql);
    } catch (e) {
      throw new Error(`Migración ${file} falló: ${(e as Error).message}`);
    }
  }
}

export async function stopDb(): Promise<void> {
  await pool?.end();
  await pg?.stop();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

/** Ejecuta fn dentro de una transacción como el usuario indicado (rol authenticated + JWT). */
export async function asUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** Llama una RPC (función que recibe jsonb) como usuario. */
export async function rpc<T = any>(userId: string, fn: string, payload: unknown): Promise<T> {
  return asUser(userId, async (c) => {
    const { rows } = await c.query(`select public.${fn}($1::jsonb) as r`, [JSON.stringify(payload)]);
    return rows[0].r as T;
  });
}

export const key = () => randomUUID();

/** Consulta directa como superusuario (para verificar resultados). */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pool.query(sql, params);
  return rows as T[];
}

// ---------------------------------------------------------------------------
// Datos de prueba ficticios
// ---------------------------------------------------------------------------
export interface Seed {
  sucA: string; sucB: string; almA: string; almB: string; almA2: string;
  admin: string; cajeroA: string; cajeroB: string; almacenista: string;
  lista: string; cliente: string; clienteCredito: string;
  piso: { id: string; m2: string; caja: string; pieza: string };   // permite fracción
  pisoCajas: { id: string; m2: string; caja: string };             // solo cajas completas
  servicio: { id: string; unidad: string };
}

export async function seed(): Promise<Seed> {
  const id = () => randomUUID();
  const s = {
    sucA: id(), sucB: id(), almA: id(), almB: id(), almA2: id(),
    admin: id(), cajeroA: id(), cajeroB: id(), almacenista: id(),
    lista: "", cliente: id(), clienteCredito: id(),
  } as Seed;

  await q(`insert into sucursales (id, codigo, nombre, cp_expedicion) values ($1,'CEN','Sucursal Centro','76000'),($2,'NTE','Sucursal Norte','76100')`, [s.sucA, s.sucB]);
  await q(`insert into almacenes (id, sucursal_id, nombre) values ($1,$2,'Centro'),($3,$4,'Norte'),($5,$2,'Centro Bodega')`,
    [s.almA, s.sucA, s.almB, s.sucB, s.almA2]);
  for (const suc of [s.sucA, s.sucB]) {
    const p = suc === s.sucA ? "CEN" : "NTE";
    await q(`insert into series (sucursal_id, tipo_documento, prefijo)
             select $1, t, $2 || '-' || upper(left(t,3)) from unnest(array['venta','cotizacion','entrega','entrada','traspaso','ajuste','apartado']) t`, [suc, p]);
  }
  const users: [string, string, string][] = [
    [s.admin, "Admin Prueba", "administrador"], [s.cajeroA, "Cajero Centro", "cajero"],
    [s.cajeroB, "Cajero Norte", "cajero"], [s.almacenista, "Almacenista Centro", "almacenista"],
  ];
  for (const [uid, nombre, rol] of users) {
    await q(`insert into auth.users (id, email) values ($1, $2)`, [uid, `${uid}@ejemplo.test`]);
    await q(`insert into perfiles (user_id, nombre, rol, propietario) values ($1,$2,$3,$4)`, [uid, nombre, rol, uid === s.admin]);
  }
  await q(`insert into usuario_sucursales values ($1,$2),($3,$4),($5,$2)`, [s.cajeroA, s.sucA, s.cajeroB, s.sucB, s.almacenista]);

  s.lista = (await q(`insert into listas_precios (nombre, predeterminada) values ('General', true) returning id`))[0].id;
  await q(`insert into clientes (id, nombre, razon_social, rfc, regimen_fiscal, cp_fiscal) values ($1,'Cliente Ejemplo','CLIENTE EJEMPLO','EJE010101AB1','612','76000')`, [s.cliente]);
  await q(`insert into clientes (id, nombre, razon_social, rfc, regimen_fiscal, cp_fiscal, limite_credito, dias_credito)
           values ($1,'Constructora Ficticia','CONSTRUCTORA FICTICIA','CFI010101AB2','601','76000', 10000, 30)`, [s.clienteCredito]);

  // Piso cerámico ficticio: base m², caja 1.44 m², pieza 0.36 m²
  const piso = (await q(`insert into productos (sku, nombre, unidad_base, clave_sat_unidad, clave_sat_prodserv, costo_promedio, ultimo_costo)
                         values ('PIS-001','Piso Cerámico Ficticio 60x60','M2','MTK','30161602', 150, 150) returning id`))[0].id;
  const m2 = (await q(`select id from unidades_venta where producto_id=$1 and es_base`, [piso]))[0].id;
  const caja = (await q(`insert into unidades_venta (producto_id, nombre, factor, clave_sat_unidad) values ($1,'CAJA',1.44,'XBX') returning id`, [piso]))[0].id;
  const pieza = (await q(`insert into unidades_venta (producto_id, nombre, factor, clave_sat_unidad) values ($1,'PIEZA',0.36,'H87') returning id`, [piso]))[0].id;
  await q(`insert into precios (lista_id, unidad_venta_id, precio) values ($1,$2,250),($1,$3,360),($1,$4,90)`, [s.lista, m2, caja, pieza]);
  s.piso = { id: piso, m2, caja, pieza };

  const pc = (await q(`insert into productos (sku, nombre, unidad_base, clave_sat_unidad, permite_fraccion, costo_promedio)
                       values ('PIS-002','Porcelanato Ficticio Solo Cajas','M2','MTK', false, 200) returning id`))[0].id;
  const pcm2 = (await q(`select id from unidades_venta where producto_id=$1 and es_base`, [pc]))[0].id;
  const pccaja = (await q(`insert into unidades_venta (producto_id, nombre, factor, clave_sat_unidad) values ($1,'CAJA',1.44,'XBX') returning id`, [pc]))[0].id;
  await q(`insert into precios (lista_id, unidad_venta_id, precio) values ($1,$2,300),($1,$3,432)`, [s.lista, pcm2, pccaja]);
  s.pisoCajas = { id: pc, m2: pcm2, caja: pccaja };

  const sv = (await q(`insert into productos (sku, nombre, tipo, unidad_base, clave_sat_unidad) values ('SRV-001','Flete Ficticio','servicio','SERV','E48') returning id`))[0].id;
  const svu = (await q(`select id from unidades_venta where producto_id=$1 and es_base`, [sv]))[0].id;
  await q(`insert into precios (lista_id, unidad_venta_id, precio) values ($1,$2,500)`, [s.lista, svu]);
  s.servicio = { id: sv, unidad: svu };
  return s;
}

/** Existencia actual en unidad base. */
export async function stock(producto: string, almacen: string): Promise<number> {
  const r = await q(`select cantidad from existencias where producto_id=$1 and almacen_id=$2`, [producto, almacen]);
  return r.length ? Number(r[0].cantidad) : 0;
}
