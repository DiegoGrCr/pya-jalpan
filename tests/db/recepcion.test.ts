/** 0047: recepción de mercancía, cancelación y proveedores. */
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { startDb, stopDb, seed, rpc, key, q, stock, Seed } from "./setup";

let s: Seed;
beforeAll(async () => { await startDb(); s = await seed(); }, 180_000);
afterAll(async () => { await stopDb(); });

const costo = async (id: string) => Number((await q(`select costo_promedio from productos where id = $1`, [id]))[0].costo_promedio);

describe("recepción de mercancía", () => {
  it("proveedor nuevo desde el almacenista; RFC y nombre repetido validados", async () => {
    const p = await rpc(s.almacenista, "guardar_proveedor", { nombre: "Proveedor de Ejemplo", rfc: "AAA010101AAA", telefono: "000" });
    expect(p.proveedor_id).toBeTruthy();
    await expect(rpc(s.almacenista, "guardar_proveedor", { nombre: "proveedor de ejemplo" })).rejects.toThrow(/Ya existe/);
    await expect(rpc(s.almacenista, "guardar_proveedor", { nombre: "Otro", rfc: "MAL" })).rejects.toThrow(/RFC/);
    await expect(rpc(s.cajeroA, "guardar_proveedor", { nombre: "Sin permiso" })).rejects.toThrow(/permiso/);
  });

  it("recibe, sube existencia y costo; crea la serie si falta; no acepta servicios", async () => {
    await q(`delete from series where sucursal_id = $1 and tipo_documento = 'entrada'`, [s.sucA]);
    const [prov] = await q(`select id from proveedores limit 1`);
    const antes = await stock(s.piso.id, s.almA);
    const e = await rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA, proveedor_id: prov.id, documento_proveedor: "FAC-1",
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 10, costo_unitario: 288 }] });
    expect(e.serie).toBe("CENE");
    expect(Number(e.total)).toBe(2880);
    const factor = Number((await q(`select factor from unidades_venta where id = $1`, [s.piso.caja]))[0].factor);
    expect(await stock(s.piso.id, s.almA)).toBeCloseTo(antes + factor * 10, 4);
    await expect(rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA,
      partidas: [{ producto_id: s.servicio.id, unidad_venta_id: s.servicio.unidad, cantidad: 1, costo_unitario: 1 }] })).rejects.toThrow(/servicios/);
  });

  it("cancelar devuelve la existencia y el costo promedio; pide motivo", async () => {
    const c0 = await costo(s.pisoCajas.id), e0 = await stock(s.pisoCajas.id, s.almA);
    const a = await rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA,
      partidas: [{ producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.caja, cantidad: 5, costo_unitario: 100 }] });
    const eA = await stock(s.pisoCajas.id, s.almA);
    const b = await rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA,
      partidas: [{ producto_id: s.pisoCajas.id, unidad_venta_id: s.pisoCajas.caja, cantidad: 5, costo_unitario: 300 }] });
    const cAmbas = await costo(s.pisoCajas.id);
    await expect(rpc(s.almacenista, "cancelar_entrada", { entrada_id: b.entrada_id })).rejects.toThrow(/motivo/);
    await rpc(s.almacenista, "cancelar_entrada", { entrada_id: b.entrada_id, motivo: "Se capturó mal" });
    const cDespues = await costo(s.pisoCajas.id);
    expect(cDespues).toBeLessThan(cAmbas);
    expect(await stock(s.pisoCajas.id, s.almA)).toBeCloseTo(eA, 6);   // vuelve a lo que había tras la primera entrada
    const [m] = await q(`select count(*)::int n from movimientos where documento_id = $1 and tipo = 'cancelacion_entrada'`, [b.entrada_id]);
    expect(m.n).toBe(1);
    await expect(rpc(s.almacenista, "cancelar_entrada", { entrada_id: b.entrada_id, motivo: "x" })).rejects.toThrow(/ya está cancelada/);
    expect(c0).toBeGreaterThanOrEqual(0); expect(a.entrada_id).toBeTruthy();
  });

  it("no se cancela si la mercancía ya se vendió", async () => {
    const e = await rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA2,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, costo_unitario: 100 }] });
    await rpc(s.cajeroA, "confirmar_venta", { idempotency_key: key(), sucursal_id: s.sucA, almacen_id: s.almA2, tipo: "contado",
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.caja, cantidad: 2, precio_unitario: 360 }],
      pagos: [{ forma: "efectivo", importe: 100000 }] });
    await expect(rpc(s.almacenista, "cancelar_entrada", { entrada_id: e.entrada_id, motivo: "Prueba" })).rejects.toThrow(/existencia suficiente/);
  });
});

describe("documento del proveedor", () => {
  it("IVA por renglón y descuento global; el costo promedio va sin IVA y con descuento", async () => {
    const e = await rpc(s.almacenista, "registrar_entrada", { idempotency_key: key(), almacen_id: s.almA,
      tipo_documento: "factura", fecha_documento: "2026-11-18", dias_credito: 30, descuento: 100,
      partidas: [{ producto_id: s.piso.id, unidad_venta_id: s.piso.pieza, cantidad: 10, costo_unitario: 100, iva_tasa: 0.16 }] });
    const [d] = await q(`select subtotal, descuento, iva, total, tipo_documento, dias_credito from entradas where id = $1`, [e.entrada_id]);
    expect(Number(d.subtotal)).toBe(1000);
    expect(Number(d.descuento)).toBe(100);
    expect(Number(d.iva)).toBe(144);
    expect(Number(d.total)).toBe(1044);
    expect(d.tipo_documento).toBe("factura");
    expect(d.dias_credito).toBe(30);
    const [m] = await q(`select costo_unitario from movimientos where documento_id = $1`, [e.entrada_id]);
    const [f] = await q(`select factor from unidades_venta where id = $1`, [s.piso.pieza]);
    expect(Number(m.costo_unitario)).toBeCloseTo(90 / Number(f.factor), 4);
  });
});
