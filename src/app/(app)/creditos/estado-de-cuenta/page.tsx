"use client";
/**
 * Créditos › Estado de cuenta de un cliente: saldo inicial, cargos (notas a crédito o que quedaron con saldo),
 * abonos (pagos y devoluciones descontadas del saldo) con saldo acumulado; resumen (debe, vencido, saldo a favor,
 * crédito disponible) y notas pendientes. Imprimir / PDF y Excel. ?cliente=id lo abre directo.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO } from "@/lib/documentoVenta";
import DialogoPagoCliente from "@/components/DialogoPagoCliente";
import { EsqueletoTabla } from "@/components/Esqueleto";
import { descargarLibro, useSoloConsulta } from "@/lib/rol";

interface Cliente { id: string; nombre: string; razon_social: string | null; rfc: string | null; telefono: string | null; correo_facturas: string | null;
  limite_credito: string; dias_credito: number; bloqueado: boolean; saldo_a_favor?: string }
interface Venta { id: string; serie: string; folio: number; fecha: string; vencimiento: string | null; total: string; saldo: string; tipo: string; con_abono?: boolean;
  sucursales: { codigo: string } | null }
interface Mov { fecha: string; tipo: "cargo" | "abono"; texto: string; detalle: string; importe: number; ventaId: string }

const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const haceMeses = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toLocaleDateString("en-CA", tz); };
const diaDe = (iso: string) => new Date(iso).toLocaleDateString("en-CA", tz);
const corta = (d: string) => d.slice(0, 10).split("-").reverse().join("/");
const $ = (n: number) => `${n < 0 ? "−" : ""}$${fmtImporte(Math.abs(n))}`;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export default function EstadoDeCuenta() {
  const solo = useSoloConsulta();
  const [cliente, setCliente] = useState<Cliente | null>(null);
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<{ id: string; nombre: string; razon_social: string | null; telefono: string | null }[]>([]);
  const [desde, setDesde] = useState(haceMeses(3));
  const [hasta, setHasta] = useState(hoy());
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [movs, setMovs] = useState<Mov[]>([]);
  const [cargando, setCargando] = useState(false);
  const [cobrar, setCobrar] = useState(false);
  const [empresa, setEmpresa] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const abrirCliente = useCallback(async (id: string) => {
    const sb = supabase();
    const cols = "id, nombre, razon_social, rfc, telefono, correo_facturas, limite_credito, dias_credito, bloqueado";
    let r = await sb.from("clientes").select(`${cols}, saldo_a_favor`).eq("id", id).maybeSingle();
    if (r.error) r = await sb.from("clientes").select(cols).eq("id", id).maybeSingle();
    if (r.data) setCliente(r.data as Cliente);
  }, []);

  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("cliente");
    if (id) abrirCliente(id);
    supabase().from("empresa").select("razon_social, nombre_emisor").eq("id", 1).maybeSingle()
      .then(({ data }: { data: unknown }) => { const e = data as { razon_social?: string; nombre_emisor?: string } | null; setEmpresa(e?.nombre_emisor || e?.razon_social || ""); });
  }, [abrirCliente]);

  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (t.length < 2) { setLista([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabase().from("clientes").select("id, nombre, razon_social, telefono").eq("es_publico_general", false)
        .or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,rfc.ilike.%${t}%,telefono.ilike.%${t}%`).order("nombre").limit(10);
      setLista((data ?? []) as typeof lista);
    }, 200);
    return () => clearTimeout(h);
  }, [texto]);

  const cargar = useCallback(async () => {
    if (!cliente) return;
    setCargando(true);
    try {
      const sb = supabase();
      let rv = await sb.from("ventas").select("id, serie, folio, fecha, vencimiento, total, saldo, tipo, con_abono, sucursales(codigo)")
        .eq("cliente_id", cliente.id).eq("estado", "confirmada").order("fecha").limit(3000);
      if (rv.error) rv = await sb.from("ventas").select("id, serie, folio, fecha, vencimiento, total, saldo, tipo, sucursales(codigo)")
        .eq("cliente_id", cliente.id).eq("estado", "confirmada").order("fecha").limit(3000);
      if (rv.error) throw rv.error;
      const todas = (rv.data ?? []) as unknown as Venta[];
      setVentas(todas);
      const ids = todas.map((v) => v.id);
      const pagos = ids.length ? ((await sb.from("venta_pagos").select("venta_id, fecha, forma, importe, referencia").in("venta_id", ids)).data ?? []) as
        { venta_id: string; fecha: string; forma: string; importe: string; referencia: string | null }[] : [];
      const dev = ids.length ? await sb.from("devoluciones_producto").select("venta_id, fecha, aplicado_saldo").in("venta_id", ids).gt("aplicado_saldo", 0) : { data: [] };
      const pagadoDe = new Map<string, number>();
      for (const p of pagos) pagadoDe.set(p.venta_id, (pagadoDe.get(p.venta_id) ?? 0) + Number(p.importe));
      // Entran al estado de cuenta las notas a crédito y las que quedaron con saldo (no las de contado pagadas al momento)
      const conCredito = new Set(todas.filter((v) => v.tipo === "credito" || v.con_abono || Number(v.saldo) > 0
        || pagos.some((p) => p.venta_id === v.id && diaDe(p.fecha) !== diaDe(v.fecha))).map((v) => v.id));
      const porId = new Map(todas.map((v) => [v.id, v]));
      const m: Mov[] = [];
      for (const v of todas) if (conCredito.has(v.id))
        m.push({ fecha: v.fecha, tipo: "cargo", texto: `Nota ${v.serie} ${v.folio}`, detalle: `${v.sucursales?.codigo ?? ""}${v.vencimiento ? ` · vence ${corta(v.vencimiento)}` : ""}`, importe: Number(v.total), ventaId: v.id });
      for (const p of pagos) if (conCredito.has(p.venta_id)) {
        const v = porId.get(p.venta_id)!;
        m.push({ fecha: p.fecha, tipo: "abono", texto: `Pago ${FORMAS_PAGO[p.forma] ?? p.forma}`, detalle: `a ${v.serie} ${v.folio}${p.referencia ? ` · ${p.referencia}` : ""}`, importe: Number(p.importe), ventaId: v.id });
      }
      for (const d of ((dev.data ?? []) as { venta_id: string; fecha: string; aplicado_saldo: string }[])) if (conCredito.has(d.venta_id)) {
        const v = porId.get(d.venta_id)!;
        m.push({ fecha: d.fecha, tipo: "abono", texto: "Devolución de material", detalle: `de ${v.serie} ${v.folio}`, importe: Number(d.aplicado_saldo), ventaId: v.id });
      }
      m.sort((a, b) => a.fecha.localeCompare(b.fecha) || (a.tipo === "cargo" ? -1 : 1));
      setMovs(m);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [cliente]);
  useEffect(() => { cargar(); }, [cargar]);

  const { inicial, periodo, final } = useMemo(() => {
    let saldo = 0;
    const periodo: (Mov & { saldo: number })[] = [];
    let inicial = 0;
    for (const x of movs) {
      const d = diaDe(x.fecha);
      if (d < desde) { inicial += x.tipo === "cargo" ? x.importe : -x.importe; continue; }
      if (d > hasta) continue;
      if (!periodo.length) saldo = inicial;
      saldo += x.tipo === "cargo" ? x.importe : -x.importe;
      periodo.push({ ...x, saldo });
    }
    return { inicial, periodo, final: periodo.length ? periodo[periodo.length - 1].saldo : inicial };
  }, [movs, desde, hasta]);

  const pendientes = ventas.filter((v) => Number(v.saldo) > 0);
  const debe = pendientes.reduce((a, v) => a + Number(v.saldo), 0);
  const vencido = pendientes.filter((v) => v.vencimiento && v.vencimiento < hoy()).reduce((a, v) => a + Number(v.saldo), 0);
  const limite = Number(cliente?.limite_credito ?? 0);
  const cargos = periodo.filter((x) => x.tipo === "cargo").reduce((a, x) => a + x.importe, 0);
  const abonos = periodo.filter((x) => x.tipo === "abono").reduce((a, x) => a + x.importe, 0);
  const nombre = cliente ? cliente.razon_social || cliente.nombre : "";

  const imprimir = () => {
    if (!cliente) return;
    const filas = periodo.map((x) => `<tr><td>${corta(diaDe(x.fecha))}</td><td>${esc(x.texto)}<br><small>${esc(x.detalle)}</small></td>
      <td class="r">${x.tipo === "cargo" ? $(x.importe) : ""}</td><td class="r">${x.tipo === "abono" ? $(x.importe) : ""}</td><td class="r">${$(x.saldo)}</td></tr>`).join("");
    const pend = pendientes.map((v) => `<tr><td>${esc(v.serie)} ${v.folio}</td><td>${corta(v.fecha)}</td><td>${v.vencimiento ? corta(v.vencimiento) : "—"}</td><td class="r">${$(Number(v.saldo))}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Estado de cuenta ${esc(nombre)}</title><style>
      body{font-family:Arial,sans-serif;font-size:11px;color:#1d2b2a;margin:24px}h1{color:#0f766e;font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 0}
      table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#0f766e;color:#fff;text-align:left;padding:5px;font-weight:normal}
      td{padding:4px 5px;border-bottom:1px solid #dfe7e5;vertical-align:top}.r{text-align:right}.res{display:flex;gap:24px;margin-top:10px}.res div b{display:block;font-size:14px}</style></head><body>
      <h1>Estado de cuenta</h1><div>${esc(empresa)}</div>
      <div style="margin-top:6px">Cliente: <b>${esc(nombre)}</b>${cliente.rfc ? ` · RFC ${esc(cliente.rfc)}` : ""}${cliente.telefono ? ` · Tel. ${esc(cliente.telefono)}` : ""}</div>
      <div>Del ${corta(desde)} al ${corta(hasta)}${limite > 0 ? ` · Crédito: ${$(limite)} a ${cliente.dias_credito} días` : ""}</div>
      <div class="res"><div>Saldo inicial<b>${$(inicial)}</b></div><div>Cargos<b>${$(cargos)}</b></div><div>Abonos<b>${$(abonos)}</b></div><div>Saldo final<b>${$(final)}</b></div><div>Vencido hoy<b>${$(vencido)}</b></div></div>
      <table><thead><tr><th>Fecha</th><th>Concepto</th><th class="r">Cargo</th><th class="r">Abono</th><th class="r">Saldo</th></tr></thead>
      <tbody><tr><td>${corta(desde)}</td><td>Saldo inicial</td><td></td><td></td><td class="r">${$(inicial)}</td></tr>${filas}</tbody></table>
      ${pend ? `<h2>Notas pendientes de pago</h2><table><thead><tr><th>Nota</th><th>Fecha</th><th>Vence</th><th class="r">Saldo</th></tr></thead><tbody>${pend}</tbody></table>` : ""}
      </body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  const excel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Estado de cuenta");
    ws.addRow([`Estado de cuenta · ${nombre}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
    ws.addRow([`Del ${corta(desde)} al ${corta(hasta)}`]);
    ws.addRow([]);
    const h = ws.addRow(["Fecha", "Concepto", "Detalle", "Cargo", "Abono", "Saldo"]);
    h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
    ws.addRow([corta(desde), "Saldo inicial", "", null, null, inicial]);
    for (const x of periodo) ws.addRow([corta(diaDe(x.fecha)), x.texto, x.detalle, x.tipo === "cargo" ? x.importe : null, x.tipo === "abono" ? x.importe : null, x.saldo]);
    ws.columns.forEach((c, i) => { c.width = [12, 28, 30, 14, 14, 14][i]; if (i >= 3) c.numFmt = '"$"#,##0.00;[Red]-"$"#,##0.00'; });
    await descargarLibro(wb, `estado-de-cuenta-${nombre.replace(/[^\wÁÉÍÓÚÑáéíóúñ ]/g, "").slice(0, 40)}-${hasta}.xlsx`);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Estado de cuenta{cliente ? `: ${nombre}` : ""}</h1>
        {cliente && <div className="flex gap-2 flex-wrap">
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" onClick={() => { setCliente(null); setMovs([]); setVentas([]); }}>Otro cliente</button>
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" onClick={excel}>Excel</button>
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" onClick={imprimir}>Imprimir / PDF</button>
          {!solo && debe > 0 && <button className="btn-primario" onClick={() => setCobrar(true)}>Registrar pago</button>}
        </div>}
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      {!cliente ? (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 max-w-xl text-sm">
          <label>Cliente<input className="campo" autoFocus placeholder="Buscar por nombre, RFC o teléfono…" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
          {lista.length > 0 && (
            <ul className="border border-[var(--borde)] rounded mt-1 max-h-72 overflow-auto">
              {lista.map((c) => <li key={c.id}><button className="w-full text-left px-2 py-1.5 hover:bg-[var(--resalte)]" onClick={() => { abrirCliente(c.id); setTexto(""); }}>
                {c.razon_social || c.nombre}{c.telefono && <span className="text-xs text-[var(--tenue)]"> · {c.telefono}</span>}</button></li>)}
            </ul>
          )}
          <p className="text-xs text-[var(--tenue)] mt-2">También se abre desde Cuentas por cobrar o desde la ficha del cliente.</p>
        </section>
      ) : (<>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 text-sm">
          {[["Debe hoy", $(debe), debe > 0 ? "text-amber-700" : ""], ["Vencido", $(vencido), vencido > 0 ? "text-[var(--peligro)]" : ""],
            ["Saldo a favor", $(Number(cliente.saldo_a_favor ?? 0)), "text-emerald-700"],
            ["Crédito", cliente.bloqueado ? "Bloqueado" : limite > 0 ? `${$(limite)} · ${cliente.dias_credito} días` : "Sin crédito", cliente.bloqueado ? "text-[var(--peligro)]" : ""],
            ["Disponible", limite > 0 && !cliente.bloqueado ? $(Math.max(0, limite - debe)) : "—", ""]].map(([k, v, cl]) => (
            <div key={k} className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">{k}</div><div className={`text-lg font-semibold ${cl}`}>{v}</div></div>
          ))}
        </div>

        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
          <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
          <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
          <div className="flex gap-2 pb-1">
            {[["3 meses", 3], ["6 meses", 6], ["1 año", 12]].map(([t, n]) => <button key={t} className="underline text-xs" onClick={() => { setDesde(haceMeses(n as number)); setHasta(hoy()); }}>{t}</button>)}
          </div>
          <Link className="underline ml-auto pb-2" href={`/ventas/clientes/${cliente.id}`}>Ficha del cliente</Link>
        </section>

        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          {cargando && !movs.length ? <div className="p-2"><EsqueletoTabla columnas={5} filas={8} /></div> : (
            <table className="w-full text-sm min-w-[700px]">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">Fecha</th><th className="font-normal">Concepto</th><th className="font-normal text-right pr-3">Cargo</th>
                <th className="font-normal text-right pr-3">Abono</th><th className="font-normal text-right pr-2">Saldo</th></tr></thead>
              <tbody>
                <tr className="border-b border-[var(--borde)] bg-[var(--resalte)]/40"><td className="p-2">{corta(desde)}</td><td className="font-medium">Saldo inicial</td><td /><td />
                  <td className="pr-2 text-right font-semibold">{$(inicial)}</td></tr>
                {periodo.map((x, i) => (
                  <tr key={i} className="border-b border-[var(--borde)] align-top">
                    <td className="p-2 whitespace-nowrap">{corta(diaDe(x.fecha))}</td>
                    <td className="py-2"><Link className="underline" href={`/ventas/${x.ventaId}`}>{x.texto}</Link><div className="text-xs text-[var(--tenue)]">{x.detalle}</div></td>
                    <td className="py-2 pr-3 text-right">{x.tipo === "cargo" ? $(x.importe) : ""}</td>
                    <td className="py-2 pr-3 text-right text-emerald-700">{x.tipo === "abono" ? $(x.importe) : ""}</td>
                    <td className="py-2 pr-2 text-right">{$(x.saldo)}</td>
                  </tr>
                ))}
                {!periodo.length && <tr><td colSpan={5} className="p-4 text-center text-[var(--tenue)]">Sin movimientos de crédito en el periodo.</td></tr>}
                <tr className="font-semibold"><td className="p-2" colSpan={2}>Totales del periodo</td><td className="pr-3 text-right">{$(cargos)}</td>
                  <td className="pr-3 text-right text-emerald-700">{$(abonos)}</td><td className="pr-2 text-right">{$(final)}</td></tr>
              </tbody>
            </table>
          )}
        </section>
        <p className="text-xs text-[var(--tenue)]">Incluye las notas a crédito y las que quedaron con saldo; las de contado pagadas al momento no se muestran porque no generan deuda.</p>
      </>)}

      {cobrar && cliente && <DialogoPagoCliente cliente={{ id: cliente.id, nombre }} onCerrar={() => setCobrar(false)}
        onListo={(t) => { setCobrar(false); setMsg({ tipo: "ok", texto: t }); cargar(); }} />}
    </div>
  );
}
