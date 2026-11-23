"use client";
/**
 * Finanzas › Pagos de clientes: todo lo cobrado en un periodo (pagos de notas al vender y abonos posteriores),
 * con filtros, totales por forma de pago y Excel. «+ Registrar pago» reparte un pago entre las notas del cliente.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { EsqueletoFilas } from "@/components/Esqueleto";
import DialogoPagoCliente from "@/components/DialogoPagoCliente";
import { descargarLibro, useSoloConsulta } from "@/lib/rol";

interface Fila {
  id: string; fecha: string; forma: string; importe: string; referencia: string | null; usuario_id: string | null; comentarios: string | null;
  ventas: { id: string; serie: string; folio: number; fecha: string; tipo: string; sucursal_id: string; sucursales: { codigo: string } | null;
    clientes: { nombre: string; razon_social: string | null } | null } | null;
}
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 7)}-01`;
const $ = (n: number) => `$${fmtImporte(n)}`;
const FORMAS = ["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito", "saldo_favor", "anticipo"];

export default function PagosClientes() {
  const solo = useSoloConsulta();
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState("");
  const [forma, setForma] = useState("");
  const [cuales, setCuales] = useState<"" | "abonos" | "al_vender">("");
  const [texto, setTexto] = useState("");
  const [cargando, setCargando] = useState(true);
  const [dialogo, setDialogo] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      let q = supabase().from("venta_pagos")
        .select("id, fecha, forma, importe, referencia, usuario_id, comentarios, ventas!inner(id, serie, folio, fecha, tipo, estado, sucursal_id, sucursales(codigo), clientes(nombre, razon_social))")
        .eq("ventas.estado", "confirmada").order("fecha", { ascending: false }).limit(3000);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (sucursal) q = q.eq("ventas.sucursal_id", sucursal);
      if (forma) q = q.eq("forma", forma);
      const { data, error } = await q;
      if (error) throw error;
      let f = (data ?? []) as unknown as Fila[];
      // Abono = pago registrado después con «Registrar pago» (lleva usuario); los pagos al vender no lo llevan
      const esAbono = (x: Fila) => !!x.usuario_id;
      if (cuales === "abonos") f = f.filter(esAbono);
      if (cuales === "al_vender") f = f.filter((x) => !esAbono(x));
      const t = texto.trim().toLowerCase();
      if (t) f = f.filter((x) => `${x.ventas?.serie} ${x.ventas?.folio} ${x.ventas?.clientes?.razon_social ?? ""} ${x.ventas?.clientes?.nombre ?? ""} ${x.referencia ?? ""}`.toLowerCase().includes(t));
      setFilas(f);
      const ids = f.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [desde, hasta, sucursal, forma, cuales, texto]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);

  const porForma = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of filas) m.set(x.forma, (m.get(x.forma) ?? 0) + Number(x.importe));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filas]);
  // Lo que entra a caja: sin saldo a favor ni anticipos de apartado (ya se cobraron antes)
  const cobrado = filas.filter((x) => x.forma !== "saldo_favor" && x.forma !== "anticipo").reduce((a, x) => a + Number(x.importe), 0);

  const excel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Pagos");
    ws.addRow([`Pagos de clientes del ${desde.split("-").reverse().join("/")} al ${hasta.split("-").reverse().join("/")}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
    ws.addRow([]);
    const h = ws.addRow(["Fecha", "Nota", "Sucursal", "Cliente", "Forma", "Referencia", "Registró", "Importe"]);
    h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
    for (const x of filas) {
      const r = ws.addRow([new Date(x.fecha), `${x.ventas?.serie} ${x.ventas?.folio}`, x.ventas?.sucursales?.codigo ?? "", x.ventas?.clientes?.razon_social || x.ventas?.clientes?.nombre || "",
        FORMAS_PAGO[x.forma] ?? x.forma, x.referencia ?? "", x.usuario_id ? nombres[x.usuario_id] ?? "" : "", Number(x.importe)]);
      r.getCell(1).numFmt = "dd/mm/yyyy hh:mm";
    }
    ws.addRow([]);
    for (const [f, v] of porForma) ws.addRow(["", "", "", "", FORMAS_PAGO[f] ?? f, "", "Total", v]).font = { bold: true };
    ws.columns.forEach((c, i) => { c.width = [17, 12, 10, 36, 18, 18, 18, 14][i]; });
    ws.getColumn(8).numFmt = '"$"#,##0.00';
    await descargarLibro(wb, `pagos-${desde}-a-${hasta}.xlsx`);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Pagos de clientes</h1>
        <div className="flex gap-2">
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" disabled={!filas.length} onClick={excel}>Descargar Excel</button>
          {!solo && <button className="btn-primario" onClick={() => setDialogo(true)}>+ Registrar pago</button>}
        </div>
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6 items-end text-sm">
        <label className="lg:col-span-2">Buscar<input className="campo" placeholder="Nota, cliente o referencia" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <label>Forma de pago
          <select className="campo" value={forma} onChange={(e) => setForma(e.target.value)}>
            <option value="">Todas</option>{FORMAS.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f] ?? f}</option>)}
          </select>
        </label>
        <label>Mostrar
          <select className="campo" value={cuales} onChange={(e) => setCuales(e.target.value as typeof cuales)}>
            <option value="">Todos los pagos</option><option value="abonos">Solo abonos (después de la venta)</option><option value="al_vender">Solo al vender</option>
          </select>
        </label>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px] items-start">
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          <table className="w-full text-sm min-w-[780px]">
            <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">Fecha</th><th className="font-normal">Nota</th><th className="font-normal">Cliente</th><th className="font-normal">Forma</th>
              <th className="font-normal">Registró</th><th className="font-normal text-right pr-2">Importe</th></tr></thead>
            <tbody>
              {cargando && !filas.length && <EsqueletoFilas columnas={6} />}
              {filas.map((x, i) => (
                <tr key={x.id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb" }}>
                  <td className="p-2 whitespace-nowrap">{fechaMx(x.fecha)}</td>
                  <td className="py-2 whitespace-nowrap">{x.ventas ? <Link className="underline" href={`/ventas/${x.ventas.id}`}>{x.ventas.serie} {x.ventas.folio}</Link> : "—"}
                    <span className="text-xs text-[var(--tenue)]"> {x.ventas?.sucursales?.codigo}</span></td>
                  <td className="py-2">{x.ventas?.clientes?.razon_social || x.ventas?.clientes?.nombre || "—"}</td>
                  <td className="py-2">{FORMAS_PAGO[x.forma] ?? x.forma}{x.referencia && <div className="text-xs text-[var(--tenue)]">{x.referencia}</div>}</td>
                  <td className="py-2">{x.usuario_id ? nombres[x.usuario_id] ?? "" : <span className="text-[var(--tenue)]">Al vender</span>}</td>
                  <td className="py-2 pr-2 text-right whitespace-nowrap">{$(Number(x.importe))}</td>
                </tr>
              ))}
              {!cargando && !filas.length && <tr><td colSpan={6} className="p-6 text-center text-[var(--tenue)]">No hay pagos con esos filtros.</td></tr>}
            </tbody>
          </table>
        </section>
        <aside className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 text-sm flex flex-col gap-3">
          <div><div className="text-[var(--tenue)]">Cobrado (entra a caja)</div><div className="text-2xl font-semibold">{$(cobrado)}</div>
            <div className="text-xs text-[var(--tenue)]">{filas.length} pago{filas.length === 1 ? "" : "s"}</div></div>
          <div>
            <h2 className="font-medium mb-1">Por forma de pago</h2>
            {porForma.map(([f, v]) => <div key={f} className="flex justify-between px-2 py-1 odd:bg-[#f4f7f6]"><span>{FORMAS_PAGO[f] ?? f}</span><span>{$(v)}</span></div>)}
            {!porForma.length && <div className="text-[var(--tenue)]">—</div>}
          </div>
          <p className="text-xs text-[var(--tenue)]">«Saldo a favor» y «Anticipo de apartado» no son dinero nuevo: ya se cobraron antes.</p>
        </aside>
      </div>

      {dialogo && <DialogoPagoCliente onCerrar={() => setDialogo(false)} onListo={(t) => { setDialogo(false); setMsg({ tipo: "ok", texto: t }); cargar(); }} />}
    </div>
  );
}
