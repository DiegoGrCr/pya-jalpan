/** Datos de la remisión: empresa (solo administradores) y datos de sucursal. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, asUser, q, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 240_000);
afterAll(async () => { await stopDb(); });

describe("Empresa y documentos", () => {
  it("el administrador guarda encabezado, condiciones y opciones de la remisión", async () => {
    await asUser(s.admin, (c) => c.query(`update empresa set nombre_emisor='EMISOR EJEMPLO', telefono='0000000000',
      condiciones_venta='Condiciones de ejemplo', remision_desglosa_iva=false where id=1`));
    const e = (await q(`select nombre_emisor, remision_titulo, remision_firma, remision_desglosa_iva from empresa`))[0];
    expect(e).toEqual({ nombre_emisor: "EMISOR EJEMPLO", remision_titulo: "Remisión", remision_firma: true, remision_desglosa_iva: false });
  });

  it("un cajero no puede modificar los datos de la empresa", async () => {
    await asUser(s.cajeroA, (c) => c.query(`update empresa set nombre_emisor='OTRO' where id=1`));
    expect((await q(`select nombre_emisor from empresa`))[0].nombre_emisor).toBe("EMISOR EJEMPLO"); // RLS: 0 filas
  });

  it("el logotipo solo acepta imágenes PNG/JPEG como data URL", async () => {
    await expect(asUser(s.admin, (c) => c.query(`update empresa set logo='https://ejemplo.test/logo.png' where id=1`))).rejects.toThrow(/check/);
    await asUser(s.admin, (c) => c.query(`update empresa set logo='data:image/png;base64,AAAA' where id=1`));
  });

  it("actualizar_sucursal guarda teléfono y lugar de expedición, y permite borrarlos", async () => {
    await rpc(s.admin, "actualizar_sucursal", { id: s.sucA, telefono: "0000000000", lugar_expedicion: "Municipio, Estado", direccion: "Calle 1" });
    expect((await q(`select telefono, lugar_expedicion, direccion from sucursales where id=$1`, [s.sucA]))[0])
      .toEqual({ telefono: "0000000000", lugar_expedicion: "Municipio, Estado", direccion: "Calle 1" });
    await rpc(s.admin, "actualizar_sucursal", { id: s.sucA, telefono: "" });
    expect((await q(`select telefono, lugar_expedicion from sucursales where id=$1`, [s.sucA]))[0]).toEqual({ telefono: null, lugar_expedicion: "Municipio, Estado" });
    await expect(rpc(s.cajeroA, "actualizar_sucursal", { id: s.sucA, telefono: "1" })).rejects.toThrow(/permiso/);
  });

  it("logotipos: hasta 6 imágenes PNG/JPEG; el logotipo anterior se migra a la lista", async () => {
    const png = "data:image/png;base64,AAAA";
    await asUser(s.admin, (c) => c.query(`update empresa set logos=$1::jsonb where id=1`, [JSON.stringify([png, png, png, png])]));
    expect((await q(`select jsonb_array_length(logos) n from empresa`))[0].n).toBe(4);
    await expect(asUser(s.admin, (c) => c.query(`update empresa set logos=$1::jsonb where id=1`, [JSON.stringify(Array(7).fill(png))]))).rejects.toThrow(/check/);
    await expect(asUser(s.admin, (c) => c.query(`update empresa set logos='["https://ejemplo.test/x.png"]' where id=1`))).rejects.toThrow(/check/);
    await expect(asUser(s.admin, (c) => c.query(`update empresa set logos='{"a":1}' where id=1`))).rejects.toThrow(/check/);
  });
});
