"use client";
/**
 * Finanzas › Cuentas por cobrar: lo que deben los clientes, con antigüedad de saldos
 * (por vencer, 1–30, 31–60, 61–90 y más de 90 días vencido), por cliente y sus notas.
 * Acciones: cobrar (reparte el pago entre sus notas), estado de cuenta y Excel.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { EsqueletoFilas } from "@/components/Esqueleto";
import { BotonAccion } from "@/components/Iconos";
import DialogoPagoCliente from "@/components/DialogoPagoCliente";
import { descargarLibro, useSoloConsulta } from "@/lib/rol";

interface Nota {
  id: string; serie: string; folio: number; fecha: string; vencimiento: string | null; total: string; saldo: string; tipo: string;
  cliente_id: string; clientes: { nombre: string; razon_social: string | null; telefono: string | null; limite_credito: string; dias_credito: number } | null;
  sucursales: { codigo: string } | null;
}
const TRAMOS = [
  { k: "por_vencer", t: "Por vencer" }, { k: "d30", t: "1–30 días" }, { k: "d60", t: "31–60 días" }, { k: "d90", t: "61–90 días" }, { k: "mas", t: "Más de 90" },
] as const;
type Tramo = (typeof TRAMOS)[number]["k"];
interface Cliente { id: string; nombre: string; telefono: string | null; notas: Nota[]; total: number; tramos: Record<Tramo, number>; maxDias: number }

const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
const corta = (d: string) => d.slice(0, 10).split("-").reverse().join("/");
const $ = (n: number) => `$${fmtImporte(n)}`;
/** Días vencido (negativo o 0 = por vencer). Sin vencimiento (contado con saldo) cuenta desde la fecha de la nota. */
const diasVencido = (n: Nota) => {
  const base = n.vencimiento ?? n.fecha.slice(0, 10);
  return Math.round((new Date(`${hoy()}T12:00:00`).getTime() - new Date(`${base}T12:00:00`).getTime()) / 86_400_000);
};
const tramoDe = (d: number): Tramo => (d <= 0 ? "por_vencer" : d <= 30 ? "d30" : d <= 60 ? "d60" : d <= 90 ? "d90" : "mas");

export default function CuentasPorCobrar() {
  const solo = useSoloConsulta();
  const [notas, setNotas] = useState<Nota[]>([]);
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [sucursal, setSucursal] = useState("");
  const [texto, setTexto] = useState("");
  const [soloVencidos, setSoloVencidos] = useState(false);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cobrar, setCobrar] = useState<{ id: string; nombre: string } | null | undefined>(undefined);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      let q = supabase().from("ventas").select("id, serie, folio, fecha, vencimiento, total, saldo, tipo, cliente_id, clientes(nombre, razon_social, telefono, limite_credito, dias_credito), sucursales(codigo)")
        .eq("estado", "confirmada").gt("saldo", 0).order("fecha").limit(5000);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      const { data, error } = await q;
      if (error) throw error;
      setNotas((data ?? []) as unknown as Nota[]);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [sucursal]);
  useEffect(() => { cargar(); }, [cargar]);

  const clientes = useMemo(() => {
    const m = new Map<string, Cliente>();
    for (const n of notas) {
      const c = m.get(n.cliente_id) ?? { id: n.cliente_id, nombre: n.clientes?.razon_social || n.clientes?.nombre || "—", telefono: n.clientes?.telefono ?? null,
        notas: [], total: 0, tramos: { por_vencer: 0, d30: 0, d60: 0, d90: 0, mas: 0 }, maxDias: -Infinity };
      const d = diasVencido(n), s = Number(n.saldo);
      c.notas.push(n); c.total += s; c.tramos[tramoDe(d)] += s; c.maxDias = Math.max(c.maxDias, d);
      m.set(n.cliente_id, c);
    }
    const t = texto.trim().toLowerCase();
    return [...m.values()]
      .filter((c) => (!t || `${c.nombre} ${c.telefono ?? ""}`.toLowerCase().includes(t)) && (!soloVencidos || c.maxDias > 0))
      .sort((a, b) => b.maxDias - a.maxDias || b.total - a.total);
  }, [notas, texto, soloVencidos]);

  const tot = useMemo(() => {
    const r: Record<Tramo, number> & { total: number } = { por_vencer: 0, d30: 0, d60: 0, d90: 0, mas: 0, total: 0 };
    for (const c of clientes) { r.total += c.total; for (const x of TRAMOS) r[x.k] += c.tramos[x.k]; }
    return r;
  }, [clientes]);

  const excel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const MON = '"$"#,##0.00';
    const ws = wb.addWorksheet("Por cliente");
    ws.addRow([`Cuentas por cobrar al ${corta(hoy())}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
    ws.addRow([]);
    const h = ws.addRow(["Cliente", "Teléfono", "Notas", ...TRAMOS.map((x) => x.t), "Total"]);
    h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
    for (const c of clientes) ws.addRow([c.nombre, c.telefono ?? "", c.notas.length, ...TRAMOS.map((x) => c.tramos[x.k] || null), c.total]);
    ws.addRow(["Total", "", clientes.reduce((a, c) => a + c.notas.length, 0), ...TRAMOS.map((x) => tot[x.k]), tot.total]).font = { bold: true };
    ws.columns.forEach((col, i) => { col.width = i === 0 ? 38 : 14; if (i >= 3) col.numFmt = MON; });
    const wn = wb.addWorksheet("Notas");
    const h2 = wn.addRow(["Cliente", "Nota", "Sucursal", "Fecha", "Vence", "Días vencido", "Total", "Saldo"]);
    h2.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
    for (const c of clientes) for (const n of c.notas) {
      const d = diasVencido(n);
      wn.addRow([c.nombre, `${n.serie} ${n.folio}`, n.sucursales?.codigo ?? "", corta(n.fecha), n.vencimiento ? corta(n.vencimiento) : "", d > 0 ? d : 0, Number(n.total), Number(n.saldo)]);
    }
    wn.columns.forEach((col, i) => { col.width = i === 0 ? 38 : 13; if (i >= 6) col.numFmt = MON; });
    await descargarLibro(wb, `cuentas-por-cobrar-${hoy()}.xlsx`);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Cuentas por cobrar</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" disabled={!clientes.length} onClick={excel}>Descargar Excel</button>
          {!solo && <button className="btn-primario" onClick={() => setCobrar(null)}>+ Registrar pago</button>}
        </div>
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6 text-sm">
        <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Total por cobrar</div><div className="text-xl font-semibold">{$(tot.total)}</div></div>
        {TRAMOS.map((x) => (
          <div key={x.k} className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3">
            <div className="text-[var(--tenue)]">{x.t}{x.k !== "por_vencer" && " vencido"}</div>
            <div className={`text-xl font-semibold ${x.k === "por_vencer" ? "" : tot[x.k] > 0 ? "text-[var(--peligro)]" : ""}`}>{$(tot[x.k])}</div>
          </div>
        ))}
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
        <label className="flex-1 min-w-48">Buscar<input className="campo" placeholder="Cliente o teléfono" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={soloVencidos} onChange={(e) => setSoloVencidos(e.target.checked)} /> Solo con algo vencido</label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[960px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Cliente</th><th className="font-normal text-right pr-3">Notas</th>
            {TRAMOS.map((x) => <th key={x.k} className="font-normal text-right pr-3">{x.t}</th>)}
            <th className="font-normal text-right pr-3">Total</th><th className="pr-2" /></tr></thead>
          <tbody>
            {cargando && !notas.length && <EsqueletoFilas columnas={9} />}
            {clientes.map((c) => (<Fragment key={c.id}>
              <tr className="border-b border-[var(--borde)] align-top">
                <td className="p-2"><button className="underline text-left" onClick={() => setAbierto(abierto === c.id ? null : c.id)}>{c.nombre}</button>
                  {c.telefono && <div className="text-xs text-[var(--tenue)]">{c.telefono}</div>}</td>
                <td className="py-2 pr-3 text-right">{c.notas.length}</td>
                {TRAMOS.map((x) => <td key={x.k} className={`py-2 pr-3 text-right whitespace-nowrap ${x.k !== "por_vencer" && c.tramos[x.k] > 0 ? "text-[var(--peligro)] font-semibold" : ""}`}>{c.tramos[x.k] ? $(c.tramos[x.k]) : "—"}</td>)}
                <td className="py-2 pr-3 text-right font-semibold whitespace-nowrap">{$(c.total)}</td>
                <td className="pr-2 py-1.5 text-right whitespace-nowrap"><span className="inline-flex gap-1">
                  {!solo && <button className="px-2 h-7 rounded border border-emerald-600 text-emerald-700 hover:bg-[var(--resalte)] text-xs" title={`Cobrar a ${c.nombre}`} onClick={() => setCobrar({ id: c.id, nombre: c.nombre })}>Cobrar</button>}
                  <BotonAccion tipo="abrir" titulo={`Estado de cuenta de ${c.nombre}`} href={`/creditos/estado-de-cuenta?cliente=${c.id}`} />
                </span></td>
              </tr>
              {abierto === c.id && c.notas.map((n) => {
                const d = diasVencido(n);
                return (
                  <tr key={n.id} className="border-b border-[var(--borde)] bg-[var(--resalte)]/40 text-xs">
                    <td className="py-1.5 pl-8" colSpan={2}><Link className="underline" href={`/ventas/${n.id}`}>{n.serie} {n.folio}</Link> · {n.sucursales?.codigo} · {corta(n.fecha)}
                      {n.tipo === "credito" ? "" : " · contado con saldo"}</td>
                    <td colSpan={TRAMOS.length} className={`pr-3 text-right ${d > 0 ? "text-[var(--peligro)]" : "text-[var(--tenue)]"}`}>
                      {n.vencimiento ? `Vence ${corta(n.vencimiento)}` : "Sin fecha de vencimiento"}{d > 0 ? ` · ${d} día${d === 1 ? "" : "s"} vencida` : ""}</td>
                    <td className="pr-3 text-right">{$(Number(n.saldo))}</td><td />
                  </tr>
                );
              })}
            </Fragment>))}
            {!cargando && !clientes.length && <tr><td colSpan={9} className="p-6 text-center text-[var(--tenue)]">Nadie debe nada{texto || soloVencidos || sucursal ? " con esos filtros" : ""}.</td></tr>}
          </tbody>
        </table>
      </section>
      <p className="text-xs text-[var(--tenue)]">Dale clic al nombre del cliente para ver sus notas. Las notas de contado que quedaron con saldo cuentan los días desde su fecha.</p>

      {cobrar !== undefined && <DialogoPagoCliente cliente={cobrar} onCerrar={() => setCobrar(undefined)}
        onListo={(t) => { setCobrar(undefined); setMsg({ tipo: "ok", texto: t }); cargar(); }} />}
    </div>
  );
}
