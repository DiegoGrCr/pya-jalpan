/**
 * Lectura del inventario de un almacén desde su hoja de cálculo (todas las pestañas).
 * En cada pestaña se busca la fila de encabezados que tenga "SKU" y, por nombre de columna:
 *   · "CAJAS EN EXISTENCIA" (o "CAJAS") + "PIEZAS SUELTAS" (pisos), o
 *   · "CANTIDAD" / "EXISTENCIA" (otros productos, en su unidad base).
 * Las pestañas sin esas columnas se omiten con aviso.
 */
import type { Workbook, CellValue } from "exceljs";

export interface FilaHoja { sku: string; cajas?: number | null; sueltas?: number | null; cantidad?: number | null; hoja: string; fila: number }

const norm = (v: unknown) => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toUpperCase();

/** Valor de una celda (fórmulas → su resultado; texto enriquecido → texto) */
function valor(v: CellValue): unknown {
  if (v && typeof v === "object") {
    if ("result" in v) return (v as { result: unknown }).result;
    if ("richText" in v) return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join("");
    if ("text" in v) return (v as { text: string }).text;
  }
  return v;
}
const numero = (v: unknown): number | null => {
  const x = valor(v as CellValue);
  if (x === null || x === undefined || x === "") return null;
  const n = typeof x === "number" ? x : Number(String(x).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** El identificador de la hoja dentro de su enlace */
export function idDeHoja(url: string | null | undefined): string | null {
  return url?.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

export function extraerFilas(wb: Workbook): { filas: FilaHoja[]; avisos: string[] } {
  const filas: FilaHoja[] = [], avisos: string[] = [];
  wb.eachSheet((ws) => {
    let enc = 0; const col: Record<string, number> = {};
    for (let r = 1; r <= Math.min(ws.rowCount, 6) && !enc; r++) {
      ws.getRow(r).eachCell((c, i) => { if (norm(valor(c.value)) === "SKU") enc = r; void i; });
    }
    if (!enc) { avisos.push(`Pestaña «${ws.name}»: no tiene columna SKU; se omitió.`); return; }
    ws.getRow(enc).eachCell((c, i) => {
      const h = norm(valor(c.value));
      if (h === "SKU") col.sku = i;
      else if (h.includes("CAJAS")) col.cajas ??= i;
      else if (h.includes("SUELTAS")) col.sueltas ??= i;
      else if (h === "CANTIDAD" || h === "EXISTENCIA" || h === "EXISTENCIAS") col.cantidad ??= i;
    });
    if (!col.cajas && !col.cantidad) { avisos.push(`Pestaña «${ws.name}»: no tiene columna de cajas ni de cantidad; se omitió.`); return; }
    for (let r = enc + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const sku = norm(valor(row.getCell(col.sku).value));
      if (!sku) continue;
      filas.push(col.cajas
        ? { sku, cajas: numero(row.getCell(col.cajas).value) ?? 0, sueltas: col.sueltas ? numero(row.getCell(col.sueltas).value) ?? 0 : 0, hoja: ws.name, fila: r }
        : { sku, cantidad: numero(row.getCell(col.cantidad).value) ?? 0, hoja: ws.name, fila: r });
    }
  });
  return { filas, avisos };
}

/** Descarga (vía el servidor) y lee la hoja de un almacén */
export async function leerHoja(url: string): Promise<{ filas: FilaHoja[]; avisos: string[] }> {
  const id = idDeHoja(url);
  if (!id) throw new Error("El enlace no es de una hoja de cálculo de Google.");
  const r = await fetch(`/api/hoja-inventario?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? "No se pudo descargar la hoja.");
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await r.arrayBuffer());
  return extraerFilas(wb);
}

/** Lee la hoja de un almacén y deja sus existencias iguales a la hoja (sincronizar_hoja, 0048) */
export async function sincronizarAlmacen(almacenId: string, url: string) {
  const { supabase } = await import("@/lib/supabase/client");
  const { filas, avisos } = await leerHoja(url);
  if (!filas.length) throw new Error(avisos.length ? avisos.join(" ") : "La hoja no tiene filas con SKU.");
  const { data, error } = await supabase().rpc("sincronizar_hoja", {
    p: { almacen_id: almacenId, filas: filas.map(({ sku, cajas, sueltas, cantidad }) => ({ sku, cajas, sueltas, cantidad })), avisos },
  });
  if (error) {
    if (/sincronizar_hoja/.test(error.message)) throw new Error("Falta ejecutar la migración 20261120000048_inventario_hoja.sql en Supabase.");
    throw error;
  }
  return data as ResultadoHoja;
}

export interface ResultadoHoja {
  cambios: number; iguales: number; desconocidos: string[]; sin_hoja: number; filas: number; avisos: string[];
  detalle: { sku: string; nombre: string; antes: number; hoja: number }[];
}
