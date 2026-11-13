/**
 * Documento de una venta guardada (remisión): carga los datos y genera el PDF (carta o ticket).
 * El PDF se arma en el navegador con jsPDF, sin enviar datos a servicios externos.
 * Distribución de la hoja carta: emisor y folio arriba, cuadros de Receptor y datos del documento,
 * partidas, importe con letra y totales, notas, condiciones generales y firma del cliente.
 */
import { supabase } from "@/lib/supabase/client";
import { fmtCantidad, mxn } from "@/lib/unidades";
import { fechaCorta, fechaLarga, importeConLetra } from "@/lib/letras";

export const FORMAS_PAGO: Record<string, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta_debito: "Tarjeta de débito",
  tarjeta_credito: "Tarjeta de crédito", anticipo: "Anticipo de apartado",
};

export interface PartidaDoc {
  renglon: number; sku: string; nombre: string; unidad: string; unidad_base: string; factor: string;
  cantidad: string; cantidad_base: string; cantidad_entregada: string; precio_unitario: string; descuento: string; total: string;
  iva_tasa: string; ieps_tasa: string; vendida_sin_existencia: boolean;
  /** Pisos (inventario en piezas): m² por pieza para mostrar la equivalencia en m² */
  m2_por_pieza?: number | null;
}
export interface PagoDoc { forma: string; importe: string; referencia: string | null }
export interface EmpresaDoc {
  razon_social: string | null; nombre_emisor: string | null; rfc: string | null; telefono: string | null; logos: string[];
  condiciones_venta: string | null; remision_titulo: string; remision_firma: boolean; remision_desglosa_iva: boolean;
}
export interface VentaDoc {
  id: string; serie: string; folio: number; fecha: string; tipo: "contado" | "credito"; estado: "confirmada" | "cancelada";
  subtotal: string; descuento: string; ieps: string; iva: string; total: string; pagado: string; saldo: string; cambio: string;
  vencimiento: string | null; comentarios: string | null; motivo_cancelacion: string | null; factura_uuid: string | null;
  sucursal: { codigo: string; nombre: string; cp_expedicion: string | null; direccion: string | null; telefono: string | null; lugar_expedicion: string | null };
  almacen: string;
  cliente: { nombre: string; razon_social: string | null; rfc: string | null; correo_facturas: string | null; telefono: string | null; es_publico_general: boolean };
  empresa: EmpresaDoc;
  partidas: PartidaDoc[]; pagos: PagoDoc[];
}

export const EMPRESA_VACIA: EmpresaDoc = {
  razon_social: null, nombre_emisor: null, rfc: null, telefono: null, logos: [], condiciones_venta: null,
  remision_titulo: "Remisión", remision_firma: true, remision_desglosa_iva: false,
};

export const folioDe = (v: Pick<VentaDoc, "serie" | "folio">) => `${v.serie}${v.folio}`;
export const tituloDe = (v: VentaDoc) => `${v.empresa.remision_titulo || "Remisión"} ${folioDe(v)}`;
export const emisorDe = (v: VentaDoc) => v.empresa.nombre_emisor || v.empresa.razon_social || v.sucursal.nombre;
export const fechaMx = (iso: string) =>
  new Date(iso).toLocaleString("es-MX", { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" });
export const pendienteEntrega = (v: VentaDoc) => v.partidas.some((p) => Number(p.cantidad_entregada) < Number(p.cantidad));

interface FilaVenta extends Omit<VentaDoc, "sucursal" | "almacen" | "cliente" | "empresa" | "partidas" | "pagos"> {
  sucursales: VentaDoc["sucursal"]; almacenes: { nombre: string }; clientes: VentaDoc["cliente"];
  venta_partidas: (Omit<PartidaDoc, "sku" | "nombre" | "unidad" | "unidad_base"> & { unidad_nombre: string; productos: { sku: string; nombre: string; unidad_base: string; m2_por_caja?: string | null; piezas_por_caja?: number | null } })[];
  venta_pagos: PagoDoc[];
}

const PROD = "sku, nombre, unidad_base, m2_por_caja, piezas_por_caja", PROD_BASICO = "sku, nombre, unidad_base";
const consultaVenta = (sucursal: string, prod = PROD) => `id, serie, folio, fecha, tipo, estado, subtotal, descuento, ieps, iva, total, pagado, saldo, cambio,
  vencimiento, comentarios, motivo_cancelacion, factura_uuid,
  sucursales(${sucursal}), almacenes(nombre),
  clientes(nombre, razon_social, rfc, correo_facturas, telefono, es_publico_general),
  venta_partidas(renglon, unidad_nombre, factor, cantidad, cantidad_base, cantidad_entregada, precio_unitario, descuento, total,
    iva_tasa, ieps_tasa, vendida_sin_existencia, productos(${prod})),
  venta_pagos(forma, importe, referencia)`;

/** Columna inexistente (falta aplicar una migración): Postgres 42703 / PostgREST PGRST204. */
const faltaColumna = (err: { code?: string; message?: string } | null) =>
  !!err && (err.code === "42703" || err.code === "PGRST204" || /does not exist|could not find/i.test(err.message ?? ""));

const COLS_EMPRESA = "razon_social, nombre_emisor, rfc, telefono, condiciones_venta, remision_titulo, remision_firma, remision_desglosa_iva";

/** Datos de la empresa para documentos. Tolera que falten las migraciones 0010/0011 (usa lo que haya). */
export async function cargarEmpresa(): Promise<EmpresaDoc> {
  const sb = supabase();
  for (const cols of [`${COLS_EMPRESA}, logos`, `${COLS_EMPRESA}, logo`, "razon_social, rfc"]) {
    const { data, error } = await sb.from("empresa").select(cols).maybeSingle();
    if (faltaColumna(error)) continue;
    if (error) throw error;
    const d = (data ?? {}) as Partial<EmpresaDoc> & { logo?: string | null };
    const logos = Array.isArray(d.logos) ? d.logos : d.logo ? [d.logo] : [];
    const { logo: _anterior, ...resto } = d; void _anterior;
    return { ...EMPRESA_VACIA, ...resto, logos };
  }
  return EMPRESA_VACIA;
}

export async function cargarVenta(id: string): Promise<VentaDoc | null> {
  const sb = supabase();
  const [primera, empresa] = await Promise.all([
    sb.from("ventas").select(consultaVenta("codigo, nombre, cp_expedicion, direccion, telefono, lugar_expedicion")).eq("id", id).maybeSingle(),
    cargarEmpresa(),
  ]);
  let v = primera;
  // Compatibilidad: si aún no se aplican las migraciones 0015 / 0010, se usan solo las columnas anteriores
  if (faltaColumna(v.error)) v = await sb.from("ventas").select(consultaVenta("codigo, nombre, cp_expedicion, direccion, telefono, lugar_expedicion", PROD_BASICO)).eq("id", id).maybeSingle();
  if (faltaColumna(v.error)) v = await sb.from("ventas").select(consultaVenta("codigo, nombre, cp_expedicion, direccion", PROD_BASICO)).eq("id", id).maybeSingle();
  if (v.error) throw v.error;
  if (!v.data) return null;
  const f = v.data as unknown as FilaVenta;
  const { sucursales, almacenes, clientes, venta_partidas, venta_pagos, ...resto } = f;
  return {
    ...resto, sucursal: sucursales, almacen: almacenes?.nombre ?? "", cliente: clientes,
    empresa,
    partidas: [...venta_partidas].sort((a, b) => a.renglon - b.renglon).map(({ productos, unidad_nombre, ...p }) => ({
      ...p, sku: productos.sku, nombre: productos.nombre, unidad_base: productos.unidad_base, unidad: unidad_nombre,
      m2_por_pieza: productos.m2_por_caja && productos.piezas_por_caja ? Number(productos.m2_por_caja) / productos.piezas_por_caja : null,
    })),
    pagos: venta_pagos,
  };
}

/** Texto corto para compartir por WhatsApp o correo. */
export function resumenTexto(v: VentaDoc): string {
  const lineas = v.partidas.map((p) => `• ${fmtCantidad(p.cantidad, 2)} ${p.unidad} ${p.nombre} — ${mxn(Number(p.cantidad) * Number(p.precio_unitario))}`);
  return [
    emisorDe(v),
    `${tituloDe(v)} · ${fechaMx(v.fecha)}`,
    ...lineas,
    `Total: ${mxn(v.total)}`,
    v.tipo === "credito" && Number(v.saldo) > 0 ? `Saldo pendiente: ${mxn(v.saldo)}${v.vencimiento ? ` (vence ${fechaCorta(v.vencimiento)})` : ""}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Importes que se imprimen
// ---------------------------------------------------------------------------
/** Renglones y totales tal como se muestran. Sin desglose: precios con IVA y "I.V.A. 0 %" (como en las notas). */
export function importesImpresos(v: VentaDoc) {
  const desglosa = v.empresa.remision_desglosa_iva;
  const filas = v.partidas.map((p) => {
    const divisor = desglosa ? (1 + Number(p.ieps_tasa)) * (1 + Number(p.iva_tasa)) : 1;
    const precio = Number(p.precio_unitario) / divisor;
    return { p, precio, importe: Number(p.cantidad) * precio, tasa: desglosa ? Number(p.iva_tasa) : 0 };
  });
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const subtotal = r2(filas.reduce((s, f) => s + f.importe, 0));
  const total = Number(v.total);
  const iva = desglosa ? Number(v.iva) : 0, ieps = desglosa ? Number(v.ieps) : 0;
  const descuento = r2(subtotal + iva + ieps - total);
  const tasas = [...new Set(filas.map((f) => f.tasa))];
  return { filas, subtotal, descuento: Math.abs(descuento) < 0.005 ? 0 : descuento, iva, ieps, total,
    etiquetaIva: `I.V.A. ${tasas.length === 1 ? `${Math.round(tasas[0] * 100)}%` : ""}`.trim() };
}

/** Genera el PDF. formato "carta" = hoja tamaño carta; "ticket80"/"ticket58" = rollo térmico. */
export async function generarPdf(v: VentaDoc, formato: "carta" | "ticket80" | "ticket58" = "carta"): Promise<Blob> {
  const { jsPDF } = await import("jspdf");
  const { autoTable } = await import("jspdf-autotable");
  return formato === "carta" ? pdfCarta(new jsPDF({ unit: "mm", format: "letter" }), v, autoTable) : pdfTicket(jsPDF, v, formato === "ticket58" ? 58 : 80);
}

type Doc = import("jspdf").jsPDF;
type AutoTable = typeof import("jspdf-autotable").autoTable;
type RGB = [number, number, number];
const AZUL: RGB = [0, 150, 200], GRIS: RGB = [240, 240, 240], TEXTO: RGB = [60, 60, 60];
const n2 = (x: string | number) => Number(x).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n4 = (x: string | number) => Number(x).toLocaleString("es-MX", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const pesos = (x: string | number) => `$${n2(x)}`;

function pdfCarta(doc: Doc, v: VentaDoc, autoTable: AutoTable): Blob {
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight(), M = 5, PIE = 16;
  const mitad = W / 2;
  const imp = importesImpresos(v);
  doc.setTextColor(...TEXTO);
  const nuevaPaginaSi = (y: number, alto: number) => { if (y + alto > H - PIE) { doc.addPage(); return 15; } return y; };

  // ---------- Encabezado: logotipo a la izquierda, folio y emisor a la derecha ----------
  doc.setFillColor(...AZUL).rect(mitad, 12, W - M - mitad, 6.5, "F");
  doc.setTextColor(255).setFont("helvetica", "normal").setFontSize(11.5).text(tituloDe(v), W - M - 2, 16.6, { align: "right" });
  doc.setTextColor(...TEXTO).setFontSize(8);
  const emisor = [emisorDe(v), v.empresa.rfc ? `RFC: ${v.empresa.rfc}` : "",
    (v.sucursal.telefono || v.empresa.telefono) ? `Tel.: ${v.sucursal.telefono || v.empresa.telefono}` : "",
    ...(v.sucursal.direccion ? doc.splitTextToSize(`${v.sucursal.direccion}${v.sucursal.cp_expedicion ? ` C.P ${v.sucursal.cp_expedicion}` : ""}`, W - M - mitad - 4) as string[] : []),
    v.sucursal.lugar_expedicion ?? ""].filter(Boolean);
  let yd = 22.5;
  for (const l of emisor) { doc.text(l, W - M - 2, yd, { align: "right" }); yd += 3.6; }

  const yl = dibujarLogos(doc, v.empresa.logos, M, 14, mitad - M - 8, 32);

  // ---------- Cuadros: Receptor | datos del documento ----------
  let y = Math.max(yd, yl) + 2;
  const anchoCaja = mitad - M - 3, altoCaja = 25;
  doc.setFillColor(...GRIS).rect(M, y, anchoCaja, altoCaja, "F").rect(mitad, y, W - M - mitad, altoCaja, "F");
  doc.setTextColor(...AZUL).setFontSize(10.5).text("Receptor", M + 2, y + 5.5);
  doc.setTextColor(...TEXTO).setFont("helvetica", "normal").setFontSize(7.5);
  const receptor = [
    ...(doc.splitTextToSize(v.cliente.razon_social || v.cliente.nombre, anchoCaja - 6) as string[]),
    `RFC: ${v.cliente.rfc ?? ""} Tel.: ${v.cliente.telefono ?? ""}`,
  ];
  receptor.forEach((l, i) => doc.text(l, M + 2, y + 12 + i * 3.4));

  const datos: [string, string][] = [
    ["Fecha de creación:", fechaCorta(v.fecha)],
    ["Fecha de Vencimiento:", fechaCorta(v.vencimiento ?? v.fecha)],
    ["Sucursal:", `${v.sucursal.codigo} - ${v.sucursal.nombre}`],
    ["Almacén:", v.almacen],
  ];
  if (v.tipo === "credito") datos.splice(2, 0, ["Condición de pago:", "Crédito"]);
  datos.forEach(([k, val], i) => {
    const yy = y + 5.5 + i * (datos.length > 4 ? 4.3 : 5);
    doc.setFont("helvetica", "bold").text(k, mitad + 2, yy);
    doc.setFont("helvetica", "normal").text(val, W - M - 2, yy, { align: "right" });
  });
  y += altoCaja + 7;

  // ---------- Partidas ----------
  autoTable(doc, {
    startY: y, margin: { left: M, right: M, bottom: PIE },
    head: [["Cód.", "Cant.", "Unidad.", "Descripción", "Precio\nUnitario", "Importe"]],
    body: imp.filas.map(({ p, precio, importe }) => [
      p.sku, n4(p.cantidad), p.unidad,
      [p.m2_por_pieza ? `${p.nombre} (${fmtCantidad(Number(p.cantidad_base) * p.m2_por_pieza, 4)} M2)`
        : p.unidad !== p.unidad_base ? `${p.nombre} (${fmtCantidad(p.cantidad_base, 4)} ${p.unidad_base})` : p.nombre,
        " "].join("\n"), // el último renglón se reserva para la línea de impuesto (letra chica)
      n4(precio), n4(importe),
    ]),
    theme: "plain", rowPageBreak: "avoid",
    styles: { fontSize: 8, cellPadding: { top: 1.6, bottom: 1.6, left: 1.2, right: 1.2 }, textColor: TEXTO, valign: "middle" },
    headStyles: { fillColor: AZUL, textColor: 255, fontStyle: "bold", halign: "center", valign: "middle", fontSize: 8 },
    columnStyles: { 0: { halign: "center", cellWidth: 20 }, 1: { halign: "center", cellWidth: 18 }, 2: { halign: "center", cellWidth: 25 },
      3: { halign: "center" }, 4: { halign: "center", cellWidth: 26 }, 5: { halign: "center", cellWidth: 27 } },
    didDrawCell: (d) => {
      if (d.section !== "body") return;
      doc.setDrawColor(200).line(d.cell.x, d.cell.y + d.cell.height, d.cell.x + d.cell.width, d.cell.y + d.cell.height);
      if (d.column.index === 3) {
        const tasa = imp.filas[d.row.index]?.tasa ?? 0;
        doc.setFontSize(5.5).setTextColor(...TEXTO)
          .text(`002 IVA | Tipo Factor: Tasa | Tasa: ${tasa.toFixed(4)}`, d.cell.x + d.cell.width / 2, d.cell.y + d.cell.height - d.cell.padding("bottom") - 0.8, { align: "center" });
        doc.setFontSize(8);
      }
    },
  });
  y = (doc as Doc & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 2.5;

  // ---------- Lugar de expedición, importe con letra | totales ----------
  const tot: [string, string, boolean?][] = [["Subtotal:", pesos(imp.subtotal)], ["Descuento:", pesos(imp.descuento)]];
  if (imp.ieps) tot.push(["I.E.P.S.:", pesos(imp.ieps)]);
  tot.push([`${imp.etiquetaIva}:`, pesos(imp.iva)], ["Total:", pesos(imp.total), true]);
  if (v.tipo === "credito") tot.push(["Pagado:", pesos(v.pagado)], ["Saldo:", pesos(v.saldo), true]);
  doc.setFontSize(9);
  const altoTot = tot.length * 5 + 2.5;
  y = nuevaPaginaSi(y, altoTot);
  const xTot = W - M - 66;
  // Recuadro gris con barra azul a la izquierda (como en la remisión de referencia)
  doc.setFillColor(...GRIS).rect(xTot, y, W - M - xTot, altoTot, "F");
  doc.setDrawColor(...AZUL).setLineWidth(0.8).line(xTot, y, xTot, y + altoTot).setLineWidth(0.2);
  tot.forEach(([k, val, azul], i) => {
    const yy = y + 4.6 + i * 5;
    doc.setFont("helvetica", "bold").setTextColor(...(azul ? AZUL : TEXTO)).text(k, xTot + 4, yy);
    doc.setFont("helvetica", "normal").setTextColor(...TEXTO).text(val, W - M - 2, yy, { align: "right" });
  });
  doc.setFontSize(8.5);
  const izq = [
    ...(v.sucursal.lugar_expedicion ? [`Lugar de Expedición: ${v.sucursal.lugar_expedicion}`] : []),
    ...(doc.splitTextToSize(`Importe con letra: ${importeConLetra(v.total)}`, xTot - M - 8) as string[]),
    ...(v.pagos.length ? doc.splitTextToSize(`Forma de pago: ${v.pagos.map((p) => `${FORMAS_PAGO[p.forma] ?? p.forma} ${pesos(p.importe)}${p.referencia ? ` (${p.referencia})` : ""}`).join(", ")}`, xTot - M - 8) as string[] : []),
  ];
  izq.forEach((l, i) => doc.text(l, M + 3, y + 4.6 + i * 5));
  y += Math.max(altoTot, izq.length * 5 + 2) + 5;

  // ---------- Notas ----------
  doc.setFontSize(6.5);
  const notas = v.comentarios ? doc.splitTextToSize(v.comentarios, W - 2 * M - 2) as string[] : [];
  y = nuevaPaginaSi(y, 8 + notas.length * 2.7);
  doc.setFillColor(...GRIS).rect(M, y, W - 2 * M, 6, "F");
  doc.setTextColor(...AZUL).setFontSize(10).text("Notas", M + 1, y + 4.3);
  doc.setTextColor(...TEXTO).setFontSize(6.5);
  y += 8.5;
  notas.forEach((l) => { y = nuevaPaginaSi(y, 2.7); doc.text(l, M + 1, y); y += 2.7; });
  y += 5;

  // ---------- Condiciones generales y firma ----------
  if (v.empresa.condiciones_venta) {
    doc.setFontSize(6.3);
    for (const l of doc.splitTextToSize(v.empresa.condiciones_venta, W - 2 * M - 2) as string[]) { y = nuevaPaginaSi(y, 2.6); doc.text(l, M + 1, y); y += 2.6; }
  }
  if (v.empresa.remision_firma) {
    y = nuevaPaginaSi(y, 20);
    doc.setFontSize(6.3).text(fechaLarga(v.fecha), M + 1, y);
    y += 13;
    doc.setDrawColor(...TEXTO).line(M + 1, y, M + 60, y);
    doc.text("FIRMA DEL CLIENTE", M + 1 + 29.5, y + 3, { align: "center" });
  }

  // ---------- Pie y sello de cancelada en cada página ----------
  const paginas = doc.getNumberOfPages();
  for (let i = 1; i <= paginas; i++) {
    doc.setPage(i);
    doc.setDrawColor(...AZUL).setLineWidth(1).line(M, H - 11, W - M, H - 11).setLineWidth(0.2);
    doc.setTextColor(...TEXTO).setFont("helvetica", "bold").setFontSize(8.5).text(`Página ${i} de ${paginas}`, W - M, H - 7, { align: "right" });
    doc.setFont("helvetica", "normal").setFontSize(6.5).setTextColor(130).text("Este documento no es un comprobante fiscal.", M, H - 7);
    if (v.estado === "cancelada") {
      // Sello semitransparente para que el contenido siga legible
      const GState = doc.GState as unknown as new (o: { opacity: number }) => unknown;
      doc.saveGraphicsState();
      doc.setGState(new GState({ opacity: 0.25 }));
      doc.setTextColor(220, 40, 40).setFont("helvetica", "bold").setFontSize(60)
        .text("CANCELADA", W / 2, H / 2, { align: "center", angle: 30 });
      doc.restoreGraphicsState();
      doc.setTextColor(200, 30, 30).setFont("helvetica", "bold").setFontSize(9)
        .text(`CANCELADA${v.motivo_cancelacion ? ` · Motivo: ${v.motivo_cancelacion}` : ""}`, W / 2, H - 7, { align: "center" });
    }
  }
  return doc.output("blob");
}

/** Acomoda los logotipos en cuadrícula (1 → 1×1, 2 → 2×1, 3-4 → 2×2, 5-6 → 3×2). Devuelve la Y final. */
function dibujarLogos(doc: Doc, logos: string[], x: number, y: number, ancho: number, alto: number): number {
  const n = Math.min(logos.length, 6);
  if (!n) return y;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3, filas = Math.ceil(n / cols);
  const sep = 3, cw = (ancho - sep * (cols - 1)) / cols, ch = (alto - sep * (filas - 1)) / filas;
  let fin = y;
  logos.slice(0, n).forEach((src, i) => {
    try {
      const prop = doc.getImageProperties(src);
      const k = Math.min(cw / prop.width, ch / prop.height), w = prop.width * k, h = prop.height * k;
      const cx = x + (i % cols) * (cw + sep), cy = y + Math.floor(i / cols) * (ch + sep);
      // Centrado vertical en su celda; con uno solo se alinea a la izquierda
      doc.addImage(src, prop.fileType, n === 1 ? cx : cx + (cw - w) / 2, cy + (ch - h) / 2, w, h);
      fin = Math.max(fin, cy + (n === 1 ? h + (ch - h) / 2 : ch));
    } catch { /* imagen inválida: se omite */ }
  });
  return fin;
}

function pdfTicket(JsPDF: typeof import("jspdf").jsPDF, v: VentaDoc, ancho: 58 | 80): Blob {
  const M = 3, W = ancho, util = W - 2 * M, fs = ancho === 58 ? 7 : 8;
  const imp = importesImpresos(v);
  const render = (doc: Doc) => {
    let y = 5;
    const centro = (t: string, bold = false, size = fs) => {
      doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(size);
      for (const l of doc.splitTextToSize(t, util)) { doc.text(l, W / 2, y, { align: "center" }); y += size * 0.42; }
    };
    const fila = (izq: string, der: string, bold = false) => {
      doc.setFont("helvetica", bold ? "bold" : "normal").setFontSize(fs);
      const ls = doc.splitTextToSize(izq, util - 20) as string[];
      ls.forEach((l, i) => doc.text(l, M, y + i * fs * 0.42));
      doc.text(der, W - M, y, { align: "right" }); y += ls.length * fs * 0.42;
    };
    const raya = () => { doc.setLineDashPattern([0.6, 0.6], 0).line(M, y - 1, W - M, y - 1); y += 1.5; };
    centro(emisorDe(v), true, fs + 1);
    if (v.empresa.rfc) centro(`RFC: ${v.empresa.rfc}`);
    if (v.sucursal.direccion) centro(v.sucursal.direccion);
    if (v.sucursal.telefono || v.empresa.telefono) centro(`Tel.: ${v.sucursal.telefono || v.empresa.telefono}`);
    centro(`Sucursal: ${v.sucursal.codigo} - ${v.sucursal.nombre}`);
    y += 1; centro(tituloDe(v), true); centro(fechaMx(v.fecha));
    centro(`Cliente: ${v.cliente.razon_social || v.cliente.nombre}`);
    if (v.estado === "cancelada") centro("*** CANCELADA ***", true, fs + 2);
    y += 1; raya();
    for (const f of imp.filas) {
      fila(`${f.p.sku} ${f.p.nombre}`, "");
      fila(`  ${fmtCantidad(f.p.cantidad, 4)} ${f.p.unidad} x ${n2(f.precio)}`, n2(f.importe));
    }
    raya();
    fila("Subtotal", n2(imp.subtotal));
    if (imp.descuento) fila("Descuento", `-${n2(imp.descuento)}`);
    if (imp.ieps) fila("I.E.P.S.", n2(imp.ieps));
    fila(imp.etiquetaIva, n2(imp.iva));
    fila("TOTAL", n2(imp.total), true);
    for (const p of v.pagos) fila(FORMAS_PAGO[p.forma] ?? p.forma, n2(p.importe));
    if (Number(v.cambio)) fila("Cambio", n2(v.cambio), true);
    if (v.tipo === "credito") fila("Saldo a crédito", n2(v.saldo), true);
    y += 1; centro(importeConLetra(v.total), false, fs - 1);
    if (v.comentarios) { y += 1; centro(v.comentarios); }
    y += 2; centro("Gracias por su compra"); centro("Este ticket no es un comprobante fiscal.", false, fs - 1);
    return y + 4;
  };
  const alto = render(new JsPDF({ unit: "mm", orientation: "portrait", format: [W, 1000] }));
  // Alto mayor que el ancho: si no, jsPDF voltea la hoja y se recortan los importes
  const doc = new JsPDF({ unit: "mm", orientation: "portrait", format: [W, Math.max(alto, W + 20)] });
  render(doc);
  return doc.output("blob");
}
