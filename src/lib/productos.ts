/**
 * Productos: tipos, cálculos de precio de pisos y plantilla de Excel (generar y leer).
 * La plantilla usa los mismos encabezados que la hoja de inventario actual, para poder
 * copiar/pegar o subir el archivo descargado de Google Sheets (cada pestaña se importa).
 */
import Decimal from "decimal.js";

export type Presentacion = "piso" | "unidad";

export const UNIDADES = ["PIEZA", "BULTO", "CAJA", "KG", "LITRO", "METRO", "M2", "ROLLO", "JUEGO", "PAR", "TRAMO", "SERVICIO"] as const;

/** Datos que acepta la función guardar_producto. */
export interface ProductoForm {
  id?: string;
  sku: string;
  nombre: string;
  marca: string;
  categoria: string;
  formato: string;
  presentacion: Presentacion;
  unidad: string;
  piezas_por_caja: string;
  m2_por_caja: string;
  precio_m2: string;
  precio_caja: string;
  precio_pieza: string;
  precio: string;
  codigo_barras: string;
  comentarios: string;
  activo: boolean;
}

export const PRODUCTO_VACIO: ProductoForm = {
  sku: "", nombre: "", marca: "", categoria: "", formato: "", presentacion: "piso", unidad: "PIEZA",
  piezas_por_caja: "", m2_por_caja: "", precio_m2: "", precio_caja: "", precio_pieza: "", precio: "",
  codigo_barras: "", comentarios: "", activo: true,
};

const num = (v: string | number | null | undefined): Decimal | null => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/[$,\s]/g, "");
  if (t === "") return null;
  try { const d = new Decimal(t); return d.isFinite() ? d : null; } catch { return null; }
};

/**
 * Precios de piso desde el precio por m² (sin IVA), sin redondear, igual que en la base de datos:
 * caja = m² por caja × precio m²; pieza = área de la pieza (m² por caja ÷ piezas) × precio m².
 */
export function preciosPiso(m2PorCaja: string, piezasPorCaja: string, precioM2: string) {
  const m2 = num(m2PorCaja), pz = num(piezasPorCaja), pm2 = num(precioM2);
  if (!m2 || !pz || !pm2 || pz.lte(0)) return null;
  const m2PorPieza = m2.div(pz);
  // Sin redondear a centavos: la BD guarda hasta 6 decimales
  return { caja: m2.times(pm2).toDecimalPlaces(6), pieza: m2PorPieza.times(pm2).toDecimalPlaces(6), m2PorPieza };
}

/** Área nominal de la pieza según el formato en cm ('60x60' -> 0.36 m²); null si no se puede leer. */
export function areaFormato(formato: string): Decimal | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*[xX×*]\s*(\d+(?:[.,]\d+)?)/.exec(formato ?? "");
  if (!m) return null;
  return new Decimal(m[1].replace(",", ".")).times(m[2].replace(",", ".")).div(10000);
}

/** Vista previa del SKU (la base de datos asigna el consecutivo real). */
export function prefijoSku(marca: string, categoria: string, formato: string): string {
  const pre = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  const m = /^(sin marca|n\/a|-)$/i.test(marca.trim()) ? "" : pre(marca);
  const base = m || pre(categoria) || "GEN";
  const f = formato.replace(/[^0-9]/g, "").slice(0, 8);
  return `${base}${f ? `-${f}` : ""}-###`;
}

/** Payload para guardar_producto. */
export function aPayload(f: ProductoForm): Record<string, unknown> {
  const base = {
    id: f.id, sku: f.sku.trim() || null, nombre: f.nombre.trim(), marca: f.marca.trim() || null, categoria: f.categoria.trim() || null,
    formato: f.formato.trim() || null, presentacion: f.presentacion, codigo_barras: f.codigo_barras.trim() || null,
    comentarios: f.comentarios.trim() || null, activo: f.activo,
  };
  const n = (v: string) => num(v)?.toString() ?? null;
  return f.presentacion === "piso"
    ? { ...base, piezas_por_caja: n(f.piezas_por_caja), m2_por_caja: n(f.m2_por_caja), precio_m2: n(f.precio_m2),
        precio_caja: n(f.precio_caja), precio_pieza: n(f.precio_pieza) }
    : { ...base, unidad: f.unidad, precio: n(f.precio) };
}

/** Errores de captura (antes de enviar). */
export function validar(f: ProductoForm): string[] {
  const e: string[] = [];
  if (!f.nombre.trim()) e.push("Falta la descripción.");
  if (f.presentacion === "piso") {
    const pz = num(f.piezas_por_caja);
    if (!pz || pz.lte(0) || !pz.isInteger()) e.push("Piezas por caja: número entero mayor a 0.");
    if (!num(f.m2_por_caja)?.gt(0)) e.push("m² por caja: número mayor a 0.");
  }
  // El precio es opcional: sin precio el producto se da de alta y no se puede vender hasta capturarlo
  return e;
}

// ---------------------------------------------------------------------------
// Plantilla de Excel
// ---------------------------------------------------------------------------
export const COLUMNAS = [
  { clave: "marca", titulo: "MARCA", ancho: 16, ayuda: "Opcional. Ej. Daltile. Se usa en el SKU." },
  { clave: "categoria", titulo: "CATEGORÍA", ancho: 14, ayuda: "Opcional. Ej. Pisos, Adhesivos, Mallas." },
  { clave: "formato", titulo: "FORMATO", ancho: 10, ayuda: "Pisos. Ej. 60x60. Se usa en el SKU." },
  { clave: "sku", titulo: "SKU", ancho: 16, ayuda: "Vacío = se genera solo (MARCA-FORMATO-###)." },
  { clave: "nombre", titulo: "DESCRIPCIÓN", ancho: 34, ayuda: "Obligatorio." },
  { clave: "piezas_por_caja", titulo: "PIEZAS X CAJA", ancho: 10, ayuda: "Pisos. Si viene con M² X CAJA, el producto es piso." },
  { clave: "m2_por_caja", titulo: "M² X CAJA", ancho: 10, ayuda: "Pisos." },
  { clave: "cajas", titulo: "CAJAS EN EXISTENCIA", ancho: 12, ayuda: "Pisos. Existencia inicial." },
  { clave: "piezas_sueltas", titulo: "PIEZAS SUELTAS", ancho: 10, ayuda: "Pisos. Existencia inicial." },
  { clave: "unidad", titulo: "UNIDAD", ancho: 10, ayuda: "Otros productos: PIEZA, BULTO, KG, LITRO, ROLLO… (vacío = PIEZA)." },
  { clave: "cantidad", titulo: "CANTIDAD", ancho: 10, ayuda: "Otros productos. Existencia inicial." },
  { clave: "precio", titulo: "PRECIO", ancho: 11, ayuda: "Pisos: precio por m². Otros: precio por unidad. Sin IVA. Si se deja vacío, el producto se carga sin precio." },
  { clave: "codigo_barras", titulo: "CÓDIGO DE BARRAS", ancho: 16, ayuda: "Opcional." },
  { clave: "comentarios", titulo: "COMENTARIOS", ancho: 24, ayuda: "Opcional." },
] as const;
type Clave = (typeof COLUMNAS)[number]["clave"];

/** Encabezados alternativos (hoja actual) -> clave. */
const ALIAS: Record<string, Clave> = {
  MARCA: "marca", CATEGORIA: "categoria", FORMATO: "formato", SKU: "sku", CODIGO: "sku", CLAVE: "sku",
  DESCRIPCION: "nombre", PRODUCTO: "nombre", NOMBRE: "nombre",
  PIEZASXCAJA: "piezas_por_caja", PIEZASPORCAJA: "piezas_por_caja", PZASXCAJA: "piezas_por_caja",
  M2XCAJA: "m2_por_caja", M2PORCAJA: "m2_por_caja", METROSXCAJA: "m2_por_caja",
  CAJASENEXISTENCIA: "cajas", CAJAS: "cajas", EXISTENCIACAJAS: "cajas",
  PIEZASSUELTAS: "piezas_sueltas", SUELTAS: "piezas_sueltas",
  UNIDAD: "unidad", CANTIDAD: "cantidad", EXISTENCIA: "cantidad",
  PRECIO: "precio", PRECIOM2: "precio", PRECIOPORM2: "precio",
  CODIGODEBARRAS: "codigo_barras", CODIGOBARRAS: "codigo_barras",
  COMENTARIOS: "comentarios", NOTAS: "comentarios", OBSERVACIONES: "comentarios",
};
const normal = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/²/g, "2").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Genera la plantilla .xlsx con ejemplos ficticios e instrucciones. */
export async function generarPlantilla(): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Productos", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNAS.map((c) => ({ header: c.titulo, key: c.clave, width: c.ancho }));
  const h = ws.getRow(1);
  h.font = { bold: true, color: { argb: "FF1F2937" } };
  h.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  h.height = 32;
  h.eachCell((c, i) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E2F3" } };
    c.note = COLUMNAS[i - 1].ayuda;
  });
  // Ejemplos ficticios
  ws.addRow({ marca: "Marca Ejemplo", categoria: "Pisos", formato: "60x60", nombre: "Piso Ejemplo Gris", piezas_por_caja: 4, m2_por_caja: 1.44, cajas: 10, piezas_sueltas: 2, precio: 289 });
  ws.addRow({ marca: "Marca Ejemplo", categoria: "Pisos", formato: "18x50", nombre: "Piso Ejemplo Madera", piezas_por_caja: 11, m2_por_caja: 0.99, cajas: 5, precio: 249 });
  ws.addRow({ marca: "Otra Marca", categoria: "Adhesivos", nombre: "Adhesivo Ejemplo Blanco", unidad: "BULTO", cantidad: 20, precio: 199 });
  ws.addRow({ categoria: "Valvulería", sku: "EJ-001", nombre: "Llave Ejemplo", unidad: "PIEZA", cantidad: 3, precio: 450 });
  ws.getColumn("precio").numFmt = '"$"#,##0.00';

  const ins = wb.addWorksheet("Instrucciones");
  ins.columns = [{ width: 24 }, { width: 90 }];
  ins.addRow(["Cómo llenar la plantilla"]).font = { bold: true, size: 14 };
  [
    ["Pisos", "Llena PIEZAS X CAJA y M² X CAJA. El PRECIO es por m², sin IVA; el sistema calcula la caja (m² x caja × precio) y la pieza (área de la pieza × precio). La existencia es CAJAS EN EXISTENCIA + PIEZAS SUELTAS."],
    ["Otros productos", "Deja vacías PIEZAS X CAJA y M² X CAJA. Indica UNIDAD (PIEZA, BULTO, KG…), PRECIO por unidad y CANTIDAD en existencia."],
    ["SKU", "Si lo dejas vacío se genera solo: prefijo de la marca + formato + consecutivo (ej. MAR-6060-001)."],
    ["Existencia", "Solo se carga para productos nuevos, en el almacén que elijas al importar. Si vuelves a importar, se actualizan datos y precios, no la existencia."],
    ["Pestañas", "Puedes subir el archivo descargado de tu hoja de Google (Archivo › Descargar › Excel). Se lee cada pestaña; el nombre de la pestaña se puede usar como marca o categoría."],
    ["Ejemplos", "Las filas de la hoja Productos son ejemplos ficticios: bórralas antes de importar."],
  ].forEach((r) => { const row = ins.addRow(r); row.alignment = { wrapText: true, vertical: "top" }; row.getCell(1).font = { bold: true }; });
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export interface FilaImport { fila: number; datos: Record<string, unknown>; errores: string[]; avisos: string[] }
export interface HojaImport { nombre: string; tieneMarca: boolean; tieneCategoria: boolean; filas: FilaImport[]; columnas: string[] }

/** Texto de una celda (resuelve celdas combinadas, fórmulas y texto enriquecido). */
function textoCelda(cell: import("exceljs").Cell): string {
  const c = cell.isMerged ? cell.master : cell;
  const v = c.value as unknown;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    const o = v as { result?: unknown; richText?: { text: string }[]; text?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("").trim();
    if (o.result !== undefined) return String(o.result).trim();
    if (o.text !== undefined) return String(o.text).trim();
    if (v instanceof Date) return v.toISOString();
  }
  return String(v).trim();
}

/** Lee todas las pestañas del archivo y arma las filas para importar. */
export async function leerExcel(archivo: File): Promise<HojaImport[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await archivo.arrayBuffer());
  const hojas: HojaImport[] = [];
  wb.eachSheet((ws) => {
    if (/^instrucciones$/i.test(ws.name)) return;
    // Encabezado: primera de las 5 primeras filas que tenga DESCRIPCIÓN
    let filaEnc = 0; const mapa = new Map<number, Clave>();
    for (let r = 1; r <= Math.min(5, ws.rowCount) && !filaEnc; r++) {
      const m = new Map<number, Clave>();
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell, col) => { const k = ALIAS[normal(textoCelda(cell))]; if (k && ![...m.values()].includes(k)) m.set(col, k); });
      if ([...m.values()].includes("nombre")) { filaEnc = r; m.forEach((v, k) => mapa.set(k, v)); }
    }
    if (!filaEnc) return;
    const claves = [...mapa.values()];
    const filas: FilaImport[] = [];
    for (let r = filaEnc + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const d: Record<string, string> = {};
      mapa.forEach((k, col) => { d[k] = textoCelda(row.getCell(col)); });
      if (!d.nombre) continue;
      filas.push(armarFila(r, d));
    }
    hojas.push({ nombre: ws.name, tieneMarca: claves.includes("marca"), tieneCategoria: claves.includes("categoria"), filas, columnas: claves });
  });
  return hojas;
}

function armarFila(fila: number, d: Record<string, string>): FilaImport {
  const errores: string[] = [], avisos: string[] = [];
  const n = (k: string) => { const x = num(d[k]); if (d[k] && !x) errores.push(`${k.replace(/_/g, " ")} no es un número`); return x; };
  const piezas = n("piezas_por_caja"), m2 = n("m2_por_caja"), precio = n("precio");
  const cajas = n("cajas"), sueltas = n("piezas_sueltas"), cantidad = n("cantidad");
  const esPiso = !!(piezas && m2);
  const datos: Record<string, unknown> = {
    fila, nombre: d.nombre, sku: d.sku || null, marca: d.marca || null, categoria: d.categoria || null,
    formato: d.formato || null, codigo_barras: d.codigo_barras || null, comentarios: d.comentarios || null,
  };
  if (esPiso) {
    if (!piezas!.isInteger() || piezas!.lte(0)) errores.push("piezas x caja debe ser entero");
    Object.assign(datos, { presentacion: "piso", piezas_por_caja: piezas!.toString(), m2_por_caja: m2!.toString(), precio_m2: precio?.toString() ?? null,
      cajas: cajas?.toString() ?? null, piezas_sueltas: sueltas?.toString() ?? null });
  } else {
    // Falta piezas o m² por caja: se carga igual (por caja o pieza) con aviso, en vez de rechazar la fila
    if (piezas || m2) avisos.push(`le falta ${piezas ? "M² X CAJA" : "PIEZAS X CAJA"}: se carga como producto normal, no como piso`);
    // Sin unidad: si solo trae cajas en existencia se toma CAJA, si no PIEZA
    const unidad = (d.unidad || (cajas && !cantidad ? "CAJA" : "PIEZA")).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (d.formato && !d.unidad && !piezas && !m2) avisos.push(`tiene formato pero no piezas/m² por caja: se cargará por ${unidad}`);
    if (!/^[A-Z0-9]{1,10}$/.test(unidad)) errores.push("unidad no válida");
    Object.assign(datos, { presentacion: "unidad", unidad, precio: precio?.toString() ?? null, cantidad: (cantidad ?? cajas)?.toString() ?? null });
  }
  if (!precio) avisos.push("sin precio: se carga en $0 y no se podrá vender hasta capturarlo");
  return { fila, datos, errores, avisos };
}
