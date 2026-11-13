/** Generación del PDF de la nota de venta (datos ficticios). */
import { describe, it, expect } from "vitest";
import { EMPRESA_VACIA, generarPdf, importesImpresos, resumenTexto, VentaDoc } from "@/lib/documentoVenta";
import { importeConLetra, fechaLarga } from "@/lib/letras";

const venta: VentaDoc = {
  id: "00000000-0000-0000-0000-000000000001", serie: "PV", folio: 12, fecha: "2026-11-12T18:30:00Z", tipo: "contado", estado: "confirmada",
  subtotal: "620.69", descuento: "0", ieps: "0", iva: "99.31", total: "720.00", pagado: "800.00", saldo: "0", cambio: "80.00",
  vencimiento: null, comentarios: "Entregar en obra", motivo_cancelacion: null, factura_uuid: null,
  sucursal: { codigo: "P", nombre: "PRINCIPAL", cp_expedicion: "00000", direccion: "Calle Ficticia 123", telefono: "0000000000", lugar_expedicion: "Municipio, Estado" }, almacen: "ALMACÉN PRINCIPAL",
  cliente: { nombre: "Público en general", razon_social: null, rfc: "XAXX010101000", correo_facturas: null, telefono: null, es_publico_general: true },
  empresa: { ...EMPRESA_VACIA, nombre_emisor: "EMPRESA EJEMPLO", rfc: "EJE010101AB1", condiciones_venta: "CONDICIONES GENERALES:\n" + "-Texto de ejemplo de condiciones. ".repeat(40) },
  partidas: [{ renglon: 1, sku: "DEMO-001", nombre: "Piso Demo 60x60", unidad: "CAJA", unidad_base: "M2", factor: "1.44", cantidad: "2",
    cantidad_base: "2.88", cantidad_entregada: "2", precio_unitario: "360", descuento: "0", total: "720.00", iva_tasa: "0.16", ieps_tasa: "0", vendida_sin_existencia: false }],
  pagos: [{ forma: "efectivo", importe: "800.00", referencia: null }],
};

describe("Documento de venta", () => {
  it.each(["carta", "ticket80", "ticket58"] as const)("genera PDF %s", async (f) => {
    const b = await generarPdf(venta, f);
    const txt = Buffer.from(await b.arrayBuffer()).toString("latin1");
    expect(txt.startsWith("%PDF")).toBe(true);
    expect(b.size).toBeGreaterThan(1000);
  });
  it("PDF de venta cancelada", async () => {
    const b = await generarPdf({ ...venta, estado: "cancelada", motivo_cancelacion: "Error de captura" }, "carta");
    expect(b.size).toBeGreaterThan(1000);
  });
  it("resumen para WhatsApp/correo", () => {
    const t = resumenTexto(venta);
    expect(t).toContain("Remisión PV12");
    expect(t).toContain("2 CAJA Piso Demo 60x60");
  });

  it("sin desglose: precios con IVA e IVA 0 %; con desglose: subtotal + IVA = total", () => {
    const a = importesImpresos(venta);
    expect(a).toMatchObject({ subtotal: 720, descuento: 0, iva: 0, total: 720, etiquetaIva: "I.V.A. 0%" });
    const b = importesImpresos({ ...venta, empresa: { ...venta.empresa, remision_desglosa_iva: true } });
    expect(b.subtotal).toBeCloseTo(620.69, 2);
    expect(b.etiquetaIva).toBe("I.V.A. 16%");
    expect(b.subtotal + b.iva - b.descuento).toBeCloseTo(720, 2);
    const c = importesImpresos({ ...venta, total: "700.00" }); // descuento de 20 con IVA incluido
    expect(c.descuento).toBe(20);
  });
});

describe("Importe con letra", () => {
  it.each([
    [3560, "TRES MIL QUINIENTOS SESENTA PESOS 00/100 M.N."],
    [1, "UN PESO 00/100 M.N."],
    [21.5, "VEINTIÚN PESOS 50/100 M.N."],
    [100, "CIEN PESOS 00/100 M.N."],
    [101, "CIENTO UN PESOS 00/100 M.N."],
    [1000, "MIL PESOS 00/100 M.N."],
    [21000, "VEINTIÚN MIL PESOS 00/100 M.N."],
    [1000000, "UN MILLÓN DE PESOS 00/100 M.N."],
    [2531999.99, "DOS MILLONES QUINIENTOS TREINTA Y UN MIL NOVECIENTOS NOVENTA Y NUEVE PESOS 99/100 M.N."],
    [0.45, "CERO PESOS 45/100 M.N."],
  ])("%s", (n, t) => expect(importeConLetra(n)).toBe(t));
  it("fecha larga en hora de México", () => expect(fechaLarga("2026-10-23T03:00:00Z")).toBe("22 de octubre de 2026"));
});
