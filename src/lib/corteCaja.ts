/**
 * Corte de caja: tipos, cuadre de efectivo y salidas (impresión y Excel para la contadora).
 * El cuadre sigue la hoja que usa la contadora: efectivo de ventas, menos gastos, retiros y devoluciones,
 * diferencia y lo que queda en caja.
 */
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx } from "@/lib/documentoVenta";

export interface Linea { concepto: string; forma: string; importe: number }
export interface Retiro { id: string; fecha: string; importe: number; concepto: string; usuario: string | null }
export interface Gasto extends Retiro { categoria: string; forma: string; proveedor: string | null }
export interface VentaCorte {
  id: string; serie: string; folio: number; fecha: string; tipo: string; estado: "confirmada" | "cancelada";
  cliente: string; total: number; saldo: number; anterior: boolean; pagos: Record<string, number>;
}
export interface Resumen {
  desde: string; hasta: string; ultimo_corte?: string | null; entradas: Linea[]; salidas: Linea[]; retiros: Retiro[]; retirado: number;
  gastos?: Gasto[]; gastado?: number; gastado_efectivo?: number; neto?: number; ventas?: VentaCorte[];
  total_general: number; efectivo_esperado: number; por_forma: Record<string, number>;
}
export const AVISO_SIN_VENTAS = "Detalle de ventas no disponible: falta ejecutar la migración 20261119000042_corte_ventas_cerrados.sql en Supabase.";
export const FORMAS = ["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia"];
export const $ = (n: number | string) => `$${fmtImporte(Number(n))}`;
const n = (x: unknown) => Number(x ?? 0);

/** Columnas de la tabla de ventas del corte */
export const pagoDe = (v: VentaCorte) => ({
  efectivo: n(v.pagos.efectivo),
  tarjeta: n(v.pagos.tarjeta_debito) + n(v.pagos.tarjeta_credito),
  transferencia: n(v.pagos.transferencia),
  otro: Object.entries(v.pagos).filter(([f]) => !FORMAS.includes(f)).reduce((s, [, x]) => s + n(x), 0),
});
export const estatusCorte = (v: VentaCorte) =>
  v.estado === "cancelada" ? "Cancelada" : v.anterior ? "Abono a venta anterior" : n(v.saldo) > 0 ? "Por cobrar" : "Pagada";

export function totalesVentas(ventas: VentaCorte[]) {
  const t = { efectivo: 0, tarjeta: 0, transferencia: 0, otro: 0, total: 0, porCobrar: 0, num: 0, canceladas: 0 };
  for (const v of ventas) {
    if (v.estado === "cancelada") { t.canceladas++; continue; }
    const p = pagoDe(v);
    t.efectivo += p.efectivo; t.tarjeta += p.tarjeta; t.transferencia += p.transferencia; t.otro += p.otro;
    if (!v.anterior) { t.total += n(v.total); t.num++; t.porCobrar += n(v.saldo); }
  }
  return t;
}

export interface LineaCuadre { signo: "+" | "−" | "=" | "±"; texto: string; importe: number; fuerte?: boolean; detalle?: string }

/** Cuadre del efectivo, renglón por renglón (como la hoja de la contadora). */
export function cuadreEfectivo(r: Resumen, contado?: number | null): LineaCuadre[] {
  const l: LineaCuadre[] = [];
  const ef = (xs: Linea[], c: string) => xs.filter((x) => x.concepto === c && x.forma === "efectivo").reduce((s, x) => s + n(x.importe), 0);
  for (const c of [...new Set(r.entradas.map((x) => x.concepto))]) {
    const v = ef(r.entradas, c); if (v) l.push({ signo: "+", texto: `Efectivo · ${c}`, importe: v });
  }
  for (const g of r.gastos ?? []) if (g.forma === "efectivo") l.push({ signo: "−", texto: g.concepto, detalle: `Gasto · ${g.categoria}${g.proveedor ? ` · ${g.proveedor}` : ""}`, importe: n(g.importe) });
  for (const x of r.retiros) l.push({ signo: "−", texto: x.concepto, detalle: "Retiro", importe: n(x.importe) });
  for (const c of [...new Set(r.salidas.map((x) => x.concepto))]) {
    const v = ef(r.salidas, c); if (v) l.push({ signo: "−", texto: c, detalle: "Devolución en efectivo", importe: v });
  }
  l.push({ signo: "=", texto: "Efectivo esperado en caja", importe: n(r.efectivo_esperado), fuerte: true });
  if (contado !== null && contado !== undefined && !Number.isNaN(contado)) {
    const d = contado - n(r.efectivo_esperado);
    if (d) l.push({ signo: "±", texto: d < 0 ? "Diferencia (faltante)" : "Diferencia (sobrante)", importe: d });
    l.push({ signo: "=", texto: "En caja (contado)", importe: contado, fuerte: true });
  }
  return l;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fecha = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short", year: "numeric" });

export interface DatosCorte { titulo: string; sucursal: string; empresa?: string; realizo?: string; contado?: number | null; notas?: string | null }

/** Hoja imprimible del corte */
export function htmlCorte(r: Resumen, d: DatosCorte): string {
  const vs = r.ventas ?? [];
  const t = totalesVentas(vs);
  const m = (x: number) => (x ? $(x) : "");
  const filas = vs.map((v) => {
    const p = pagoDe(v); const c = v.estado === "cancelada";
    return `<tr class="${c ? "can" : ""}"><td>${esc(v.serie)} ${v.folio}</td><td>${fecha(v.fecha)}</td><td>${esc(v.cliente)}</td>
      <td class="r">${m(p.efectivo)}</td><td class="r">${m(p.tarjeta)}</td><td class="r">${m(p.transferencia)}</td><td class="r">${m(p.otro)}</td>
      <td class="r">${c ? "$0.00" : v.anterior ? "" : $(v.total)}</td><td>${estatusCorte(v)}${!c && !v.anterior && n(v.saldo) > 0 ? ` ${$(v.saldo)}` : ""}</td></tr>`;
  }).join("");
  const cuadre = cuadreEfectivo(r, d.contado).map((x) => `<tr class="${x.fuerte ? "f" : ""}"><td class="s">${x.signo === "±" ? (x.importe < 0 ? "−" : "+") : x.signo}</td>
    <td>${esc(x.texto)}${x.detalle ? `<div class="det">${esc(x.detalle)}</div>` : ""}</td><td class="r ${x.signo === "−" || x.importe < 0 ? "neg" : ""}">${$(Math.abs(x.importe))}</td></tr>`).join("");
  const otrosGastos = (r.gastos ?? []).filter((g) => g.forma !== "efectivo");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.titulo)}</title><style>
    @page{size:letter;margin:14mm}body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#1d2b2a;margin:0}@media screen{body{margin:24px auto;max-width:960px}}
    .enc{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:3px solid #0f766e;padding-bottom:8px;margin-bottom:12px}
    h1{font-size:20px;margin:0;color:#0f766e}h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#0f766e;margin:16px 0 6px}
    table{width:100%;border-collapse:collapse}th{background:#0f766e;color:#fff;font-weight:normal;text-align:left;padding:5px 6px}
    td{padding:4px 6px;border-bottom:1px solid #dfe7e5}tbody tr:nth-child(even) td{background:#f4f8f7}.r{text-align:right;white-space:nowrap}
    .can td{color:#9aa6a4;text-decoration:line-through}.can td:last-child{text-decoration:none}
    tfoot td{font-weight:bold;border-top:2px solid #0f766e;background:#fff}
    .dos{display:grid;grid-template-columns:1fr 1fr;gap:18px}.neg{color:#b42318}.s{width:14px;color:#5b6b69}
    .f td{font-weight:bold;font-size:12px;border-top:1.5px solid #1d2b2a}.det{font-size:9.5px;color:#5b6b69}
    .firmas{display:flex;gap:60px;margin-top:50px}.firmas div{flex:1;border-top:1px solid #1d2b2a;text-align:center;padding-top:4px}
    .tenue{color:#5b6b69}</style></head><body>
    <div class="enc"><div><h1>${esc(d.titulo)}</h1><div>${esc(d.empresa ?? "")}${d.empresa ? " · " : ""}${esc(d.sucursal)}</div></div>
      <div class="r">Del ${fechaMx(r.desde)}<br>al ${fechaMx(r.hasta)}${d.realizo ? `<br><span class="tenue">Realizó: ${esc(d.realizo)}</span>` : ""}</div></div>
    <h2>Ventas</h2>
    <table><thead><tr><th>Folio</th><th>Fecha</th><th>Cliente</th><th class="r">Efectivo</th><th class="r">Tarjeta</th><th class="r">Transferencia</th><th class="r">Otro</th><th class="r">Total</th><th>Estatus</th></tr></thead>
      <tbody>${r.ventas ? filas || `<tr><td colspan="9" class="tenue">Sin ventas en el periodo</td></tr>` : `<tr><td colspan="9" class="tenue">${AVISO_SIN_VENTAS}</td></tr>`}</tbody>
      ${r.ventas ? "" : "<!--"}<tfoot><tr><td colspan="3">${t.num} venta${t.num === 1 ? "" : "s"}${t.canceladas ? ` · ${t.canceladas} cancelada${t.canceladas === 1 ? "" : "s"}` : ""}</td>
        <td class="r">${$(t.efectivo)}</td><td class="r">${$(t.tarjeta)}</td><td class="r">${$(t.transferencia)}</td><td class="r">${m(t.otro)}</td><td class="r">${$(t.total)}</td>
        <td>${t.porCobrar ? `Por cobrar ${$(t.porCobrar)}` : ""}</td></tr></tfoot>${r.ventas ? "" : "-->"}</table>
    <div class="dos">
      <div><h2>Cuadre de efectivo</h2><table><tbody>${cuadre}</tbody></table></div>
      <div><h2>Resumen</h2><table><tbody>
        ${FORMAS.map((f) => `<tr><td>${FORMAS_PAGO[f]}</td><td class="r">${$(r.por_forma?.[f] ?? 0)}</td></tr>`).join("")}
        <tr class="f"><td>Total cobrado</td><td class="r">${$(r.total_general)}</td></tr>
        ${r.gastado ? `<tr><td>Gastos (todas las formas)</td><td class="r neg">${$(r.gastado)}</td></tr><tr class="f"><td>Ingresos menos gastos</td><td class="r">${$(r.neto ?? 0)}</td></tr>` : ""}
      </tbody></table>
      ${otrosGastos.length ? `<h2>Gastos pagados sin efectivo</h2><table><tbody>${otrosGastos.map((g) => `<tr><td>${esc(g.concepto)}<div class="det">${esc(g.categoria)} · ${FORMAS_PAGO[g.forma] ?? g.forma}</div></td><td class="r">${$(g.importe)}</td></tr>`).join("")}</tbody></table>` : ""}
      </div>
    </div>
    ${d.notas ? `<p><b>Notas:</b> ${esc(d.notas)}</p>` : ""}
    <div class="firmas"><div>Realizó</div><div>Revisó</div></div>
  </body></html>`;
}

/** Abre la hoja del corte en una ventana e imprime */
export function imprimirCorte(r: Resumen, d: DatosCorte) {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  w.document.write(htmlCorte(r, d)); w.document.close(); w.focus();
  setTimeout(() => w.print(), 300);
}

/** Excel del corte (ventas + cuadre), para mandar a la contadora */
export async function excelCorte(r: Resumen, d: DatosCorte, archivo: string) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Corte");
  const MON = '"$"#,##0.00;[Red]-"$"#,##0.00';
  ws.columns = [{ width: 12 }, { width: 14 }, { width: 34 }, { width: 13 }, { width: 13 }, { width: 14 }, { width: 12 }, { width: 13 }, { width: 22 }];
  ws.addRow([d.titulo]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
  ws.addRow([`${d.empresa ? `${d.empresa} · ` : ""}${d.sucursal}`]);
  ws.addRow([`Del ${fechaMx(r.desde)} al ${fechaMx(r.hasta)}${d.realizo ? ` · Realizó: ${d.realizo}` : ""}`]);
  ws.addRow([]);
  const h = ws.addRow(["#Número", "Fecha", "Cliente", "Efectivo", "Tarjeta", "Transferencia", "Otro", "Total", "Estatus"]);
  h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
  for (const v of r.ventas ?? []) {
    const p = pagoDe(v); const c = v.estado === "cancelada";
    const row = ws.addRow([`${v.serie} ${v.folio}`, new Date(v.fecha), v.cliente, p.efectivo || null, p.tarjeta || null, p.transferencia || null, p.otro || null,
      c ? 0 : v.anterior ? null : n(v.total), `${estatusCorte(v)}${!c && !v.anterior && n(v.saldo) > 0 ? ` ${$(v.saldo)}` : ""}`]);
    row.getCell(2).numFmt = "dd/mm/yyyy";
    if (c) row.font = { color: { argb: "FF9AA6A4" } };
  }
  const t = totalesVentas(r.ventas ?? []);
  if (!r.ventas) ws.addRow(["", "", AVISO_SIN_VENTAS]).font = { italic: true, color: { argb: "FFB42318" } };
  else {
  const tot = ws.addRow(["", "", `${t.num} ventas`, t.efectivo, t.tarjeta, t.transferencia, t.otro || null, t.total, t.porCobrar ? `Por cobrar ${$(t.porCobrar)}` : ""]);
  tot.font = { bold: true }; tot.eachCell((c) => { c.border = { top: { style: "medium", color: { argb: "FF0F766E" } } }; });
  }
  ws.getColumn(4).numFmt = MON; ws.getColumn(5).numFmt = MON; ws.getColumn(6).numFmt = MON; ws.getColumn(7).numFmt = MON; ws.getColumn(8).numFmt = MON;
  ws.addRow([]);
  ws.addRow(["", "", "Cuadre de efectivo"]).font = { bold: true, color: { argb: "FF0F766E" } };
  for (const x of cuadreEfectivo(r, d.contado)) {
    const neg = x.signo === "−" || (x.signo === "±" && x.importe < 0);
    const row = ws.addRow(["", "", x.detalle ? `${x.texto} (${x.detalle})` : x.texto, null, null, null, null, neg ? -Math.abs(x.importe) : x.importe]);
    if (x.fuerte) { row.font = { bold: true }; row.getCell(8).border = { top: { style: "thin" } }; }
  }
  ws.addRow([]);
  ws.addRow(["", "", "Resumen por forma de pago"]).font = { bold: true, color: { argb: "FF0F766E" } };
  for (const f of FORMAS) ws.addRow(["", "", FORMAS_PAGO[f], null, null, null, null, n(r.por_forma?.[f])]);
  ws.addRow(["", "", "Total cobrado", null, null, null, null, n(r.total_general)]).font = { bold: true };
  if (r.gastado) {
    ws.addRow(["", "", "Gastos (todas las formas)", null, null, null, null, -n(r.gastado)]);
    ws.addRow(["", "", "Ingresos menos gastos", null, null, null, null, n(r.neto)]).font = { bold: true };
  }
  if (d.notas) { ws.addRow([]); ws.addRow(["Notas:", d.notas]); }
  const b = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(b);
  Object.assign(document.createElement("a"), { href: url, download: archivo }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
