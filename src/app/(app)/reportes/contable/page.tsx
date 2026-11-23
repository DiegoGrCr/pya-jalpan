"use client";
/**
 * Reportes › Resumen contable: un periodo (por omisión el mes) con las sucursales en columnas y el total.
 * Ventas, ventas netas, costo y utilidad (con permiso), dinero que entró por forma de pago, devoluciones,
 * gastos por categoría, retiros, cortes y, al día de hoy, por cobrar, apartados e inventario valorizado.
 * Exporta a Excel. Usa resumen_contable (0054).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO } from "@/lib/documentoVenta";
import { EsqueletoTabla } from "@/components/Esqueleto";

type Mapa = Record<string, number | string>;
interface Suc {
  sucursal_id: string; codigo: string; nombre: string;
  ventas: { num: number; canceladas: number; total_canceladas: number; subtotal: number; descuento: number; iva: number; ieps: number; total: number;
    contado: number; credito: number; con_iva: number; publico_general: number; clientes_registrados: number };
  ventas_netas: number; costo: number | null; utilidad: number | null;
  cobranza: Mapa; devoluciones: { dinero: Mapa; saldo_favor: number; productos: number };
  gastos: { total: number; con_factura?: number; categorias: { categoria: string; importe: number }[]; por_forma: Mapa };
  retiros: number; cortes: { num: number; total: number; diferencia: number; con_diferencia: number };
  por_cobrar: { saldo: number; vencido: number; notas: number }; apartados: { num: number; total: number; saldo: number }; inventario: number | null;
}
interface Resumen { desde: string; hasta: string; costos: boolean; sucursales: Suc[] }
type Fila = { texto: string; v: (s: Suc) => number | null; tipo?: "$" | "n" | "%"; nivel?: 0 | 1; fuerte?: boolean; seccion?: never } | { seccion: string };

const tz = { timeZone: "America/Mexico_City" } as const;
const mesActual = () => new Date().toLocaleDateString("en-CA", tz).slice(0, 7);
const finDeMes = (m: string) => { const [y, mm] = m.split("-").map(Number); return new Date(Date.UTC(y, mm, 0)).toISOString().slice(0, 10); };
const N = (x: unknown) => Number(x ?? 0) || 0;
const FORMAS = ["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia"];
const fechaLarga = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("es-MX", { day: "numeric", month: "long", year: "numeric" });

export default function ResumenContable() {
  const [mes, setMes] = useState(mesActual());
  const [rango, setRango] = useState<{ desde: string; hasta: string } | null>(null);   // periodo libre
  const [sucursal, setSucursal] = useState("");
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [r, setR] = useState<Resumen | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const periodo = rango ?? { desde: `${mes}-01`, hasta: finDeMes(mes) };

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("resumen_contable", { p: { desde: periodo.desde, hasta: periodo.hasta, sucursal_id: sucursal || null } });
      if (error) {
        if (/resumen_contable/.test(error.message)) throw new Error("Falta ejecutar la migración 20261123000054_resumen_contable.sql en Supabase.");
        throw error;
      }
      setR(data as Resumen);
    } catch (e) { setMsg(mensajeError(e)); setR(null); } finally { setCargando(false); }
  }, [periodo.desde, periodo.hasta, sucursal]);
  useEffect(() => { cargar(); }, [cargar]);

  const filas = useMemo<Fila[]>(() => {
    if (!r) return [];
    const categorias = [...new Set(r.sucursales.flatMap((s) => s.gastos.categorias.map((c) => c.categoria)))].sort();
    const cat = (c: string) => (s: Suc) => N(s.gastos.categorias.find((x) => x.categoria === c)?.importe);
    const sumMapa = (m: Mapa) => Object.values(m ?? {}).reduce<number>((a, x) => a + N(x), 0);
    const f: Fila[] = [
      { seccion: "Ventas del periodo" },
      { texto: "Número de ventas", v: (s) => N(s.ventas.num), tipo: "n" },
      { texto: "Subtotal", v: (s) => N(s.ventas.subtotal) + N(s.ventas.descuento) },
      { texto: "Descuentos", v: (s) => -N(s.ventas.descuento), nivel: 1 },
      { texto: "I.V.A.", v: (s) => N(s.ventas.iva), nivel: 1 },
      { texto: "Total vendido", v: (s) => N(s.ventas.total), fuerte: true },
      { texto: "De contado", v: (s) => N(s.ventas.contado), nivel: 1 },
      { texto: "A crédito", v: (s) => N(s.ventas.credito), nivel: 1 },
      { texto: "A Público en general", v: (s) => N(s.ventas.publico_general), nivel: 1 },
      { texto: "A clientes registrados", v: (s) => N(s.ventas.clientes_registrados), nivel: 1 },
      { texto: "Ventas con IVA (número)", v: (s) => N(s.ventas.con_iva), tipo: "n", nivel: 1 },
      { texto: "Devoluciones de producto", v: (s) => -N(s.devoluciones.productos) },
      { texto: "Ventas netas", v: (s) => N(s.ventas_netas), fuerte: true },
      ...(r.costos ? [
        { texto: "Costo de lo vendido", v: (s: Suc) => (s.costo == null ? null : -N(s.costo)) },
        { texto: "Utilidad bruta", v: (s: Suc) => (s.utilidad == null ? null : N(s.utilidad)), fuerte: true },
        { texto: "Margen", v: (s: Suc) => (s.utilidad == null || !N(s.ventas_netas) ? null : (N(s.utilidad) / N(s.ventas_netas)) * 100), tipo: "%" as const, nivel: 1 as const },
      ] : []),
      { texto: "Ventas canceladas (número)", v: (s) => N(s.ventas.canceladas), tipo: "n" },
      { texto: "Importe cancelado", v: (s) => N(s.ventas.total_canceladas), nivel: 1 },

      { seccion: "Dinero que entró (ventas, abonos y apartados)" },
      ...FORMAS.map((k) => ({ texto: FORMAS_PAGO[k] ?? k, v: (s: Suc) => N(s.cobranza[k]), nivel: 1 as const })),
      { texto: "Total cobrado", v: (s) => sumMapa(s.cobranza), fuerte: true },

      { seccion: "Dinero devuelto" },
      ...FORMAS.map((k) => ({ texto: FORMAS_PAGO[k] ?? k, v: (s: Suc) => -N(s.devoluciones.dinero[k]), nivel: 1 as const })),
      { texto: "Total devuelto en dinero", v: (s) => -sumMapa(s.devoluciones.dinero), fuerte: true },
      { texto: "Devuelto como saldo a favor", v: (s) => N(s.devoluciones.saldo_favor), nivel: 1 },

      { seccion: "Gastos y retiros" },
      ...categorias.map((c) => ({ texto: c, v: cat(c), nivel: 1 as const })),
      { texto: "Total de gastos", v: (s) => N(s.gastos.total), fuerte: true },
      { texto: "Gastos con factura (deducibles)", v: (s) => N(s.gastos.con_factura), nivel: 1 },
      { texto: "Gastos sin factura", v: (s) => N(s.gastos.total) - N(s.gastos.con_factura), nivel: 1 },
      { texto: "Gastos pagados en efectivo", v: (s) => N(s.gastos.por_forma?.efectivo), nivel: 1 },
      { texto: "Retiros de caja", v: (s) => N(s.retiros) },

      { seccion: "Cortes de caja" },
      { texto: "Cortes realizados", v: (s) => N(s.cortes.num), tipo: "n" },
      { texto: "Cortes con diferencia", v: (s) => N(s.cortes.con_diferencia), tipo: "n", nivel: 1 },
      { texto: "Diferencia acumulada (sobrante + / faltante −)", v: (s) => N(s.cortes.diferencia), nivel: 1 },

      { seccion: "Al día de hoy" },
      { texto: "Por cobrar a clientes", v: (s) => N(s.por_cobrar.saldo) },
      { texto: "De eso, vencido", v: (s) => N(s.por_cobrar.vencido), nivel: 1 },
      { texto: "Apartados abiertos (número)", v: (s) => N(s.apartados.num), tipo: "n" },
      { texto: "Saldo por cobrar de apartados", v: (s) => N(s.apartados.saldo), nivel: 1 },
      ...(r.costos ? [{ texto: "Inventario valorizado (a costo promedio)", v: (s: Suc) => (s.inventario == null ? null : N(s.inventario)) }] : []),
    ];
    return f;
  }, [r]);

  const varias = (r?.sucursales.length ?? 0) > 1;
  const totalDe = (f: Exclude<Fila, { seccion: string }>) => {
    if (!r) return null;
    if (f.tipo === "%") {
      const ut = r.sucursales.reduce((a, s) => a + N(s.utilidad), 0), vn = r.sucursales.reduce((a, s) => a + N(s.ventas_netas), 0);
      return vn ? (ut / vn) * 100 : null;
    }
    const vals = r.sucursales.map(f.v);
    return vals.every((x) => x == null) ? null : vals.reduce<number>((a, x) => a + (x ?? 0), 0);
  };
  const fmt = (x: number | null, tipo?: "$" | "n" | "%") =>
    x == null ? "—" : tipo === "n" ? x.toLocaleString("es-MX") : tipo === "%" ? `${x.toFixed(1)} %` : `${x < 0 ? "−" : ""}$${fmtImporte(Math.abs(x))}`;

  const excel = async () => {
    if (!r) return;
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Resumen contable");
    const MON = '"$"#,##0.00;[Red]-"$"#,##0.00';
    ws.addRow(["Resumen contable"]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
    ws.addRow([`Del ${fechaLarga(r.desde)} al ${fechaLarga(r.hasta)}`]);
    ws.addRow([]);
    const enc = ws.addRow(["Concepto", ...r.sucursales.map((s) => `${s.codigo} - ${s.nombre}`), ...(varias ? ["Total"] : [])]);
    enc.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
    for (const f of filas) {
      if ("seccion" in f && f.seccion) { const row = ws.addRow([f.seccion]); row.font = { bold: true, color: { argb: "FF0F766E" } }; continue; }
      const fi = f as Exclude<Fila, { seccion: string }>;
      const vals = r.sucursales.map(fi.v);
      const row = ws.addRow([`${fi.nivel ? "   " : ""}${fi.texto}`, ...vals.map((x) => (x == null ? null : fi.tipo === "%" ? x / 100 : x)),
        ...(varias ? [(() => { const t = totalDe(fi); return t == null ? null : fi.tipo === "%" ? t / 100 : t; })()] : [])]);
      row.eachCell((c, i) => { if (i > 1) c.numFmt = fi.tipo === "n" ? "#,##0" : fi.tipo === "%" ? "0.0%" : MON; });
      if (fi.fuerte) row.font = { bold: true };
    }
    ws.getColumn(1).width = 46;
    for (let i = 2; i <= r.sucursales.length + 2; i++) ws.getColumn(i).width = 18;
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = `resumen-contable-${r.desde}-a-${r.hasta}.xlsx`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Resumen contable</h1>
        <button className="btn-primario" disabled={!r || cargando} onClick={excel}>Descargar Excel</button>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
        <label>Mes<input type="month" className="campo" value={mes} onChange={(e) => { setMes(e.target.value || mesActual()); setRango(null); }} /></label>
        <span className="text-[var(--tenue)] pb-2">o periodo:</span>
        <label>Desde<input type="date" className="campo" value={periodo.desde} onChange={(e) => setRango({ desde: e.target.value, hasta: periodo.hasta })} /></label>
        <label>Hasta<input type="date" className="campo" value={periodo.hasta} onChange={(e) => setRango({ desde: periodo.desde, hasta: e.target.value })} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas (comparadas)</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        {cargando && !r ? <div className="p-2"><EsqueletoTabla columnas={4} filas={14} /></div> : r && (
          <table className="w-full text-sm">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">Del {fechaLarga(r.desde)} al {fechaLarga(r.hasta)}</th>
                {r.sucursales.map((s) => <th key={s.sucursal_id} className="p-2 font-normal text-right whitespace-nowrap">{s.codigo} - {s.nombre}</th>)}
                {varias && <th className="p-2 text-right">Total</th>}
              </tr>
            </thead>
            <tbody>
              {filas.map((f, i) => {
                if ("seccion" in f && f.seccion) return (
                  <tr key={i}><td colSpan={r.sucursales.length + 2} className="pt-4 pb-1 px-2 font-semibold" style={{ color: "var(--acento)" }}>{f.seccion}</td></tr>
                );
                const fi = f as Exclude<Fila, { seccion: string }>;
                return (
                  <tr key={i} className={`border-b border-[var(--borde)] ${fi.fuerte ? "font-semibold" : ""}`}>
                    <td className={`py-1.5 ${fi.nivel ? "pl-6 text-[var(--tenue)]" : "pl-2"}`}>{fi.texto}</td>
                    {r.sucursales.map((s) => { const x = fi.v(s); return <td key={s.sucursal_id} className={`px-2 text-right whitespace-nowrap ${x != null && x < 0 ? "text-[var(--peligro)]" : ""}`}>{fmt(x, fi.tipo)}</td>; })}
                    {varias && <td className="px-2 text-right whitespace-nowrap font-semibold">{fmt(totalDe(fi), fi.tipo)}</td>}
                  </tr>
                );
              })}
              {!r.sucursales.length && <tr><td className="p-6 text-center text-[var(--tenue)]">No tienes sucursales para consultar.</td></tr>}
            </tbody>
          </table>
        )}
      </section>
      <p className="text-xs text-[var(--tenue)]">
        Ventas por fecha de la nota; dinero por fecha en que se cobró o devolvió. «Al día de hoy» no depende del periodo.
        {r && !r.costos && " Costo, utilidad e inventario valorizado solo se muestran a quien tiene permiso de ver costos."}
      </p>
    </div>
  );
}
