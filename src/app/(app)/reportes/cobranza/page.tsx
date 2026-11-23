"use client";
/**
 * Reportes › Cobranza: lo cobrado de cuentas por cobrar en un periodo (abonos registrados después de la venta),
 * por cliente, forma de pago, sucursal y día; días promedio que tardan en pagar; y por cobrar / vencido hoy. Excel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO } from "@/lib/documentoVenta";
import { EsqueletoTabla } from "@/components/Esqueleto";
import { descargarLibro } from "@/lib/rol";

interface Pago { fecha: string; forma: string; importe: string; ventas: { id: string; fecha: string; cliente_id: string; sucursal_id: string; sucursales: { codigo: string } | null;
  clientes: { nombre: string; razon_social: string | null } | null } | null }
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 7)}-01`;
const dia = (iso: string) => new Date(iso).toLocaleDateString("en-CA", tz);
const $ = (n: number) => `$${fmtImporte(n)}`;

export default function ReporteCobranza() {
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState("");
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [pagos, setPagos] = useState<Pago[] | null>(null);
  const [cartera, setCartera] = useState<{ saldo: number; vencido: number; clientes: number }>({ saldo: 0, vencido: 0, clientes: 0 });
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const sb = supabase();
      // Abonos = pagos registrados después con «Registrar pago» (llevan usuario); los cobrados al vender no son cobranza
      let q = sb.from("venta_pagos").select("fecha, forma, importe, ventas!inner(id, fecha, estado, cliente_id, sucursal_id, sucursales(codigo), clientes(nombre, razon_social))")
        .not("usuario_id", "is", null).eq("ventas.estado", "confirmada")
        .gte("fecha", `${desde}T00:00:00-06:00`).lte("fecha", `${hasta}T23:59:59.999-06:00`).order("fecha").limit(10000);
      if (sucursal) q = q.eq("ventas.sucursal_id", sucursal);
      const { data, error } = await q;
      if (error) throw error;
      setPagos((data ?? []) as unknown as Pago[]);
      let c = sb.from("ventas").select("cliente_id, saldo, vencimiento").eq("estado", "confirmada").gt("saldo", 0).limit(10000);
      if (sucursal) c = c.eq("sucursal_id", sucursal);
      const { data: cv } = await c;
      const filas = (cv ?? []) as { cliente_id: string; saldo: string; vencimiento: string | null }[];
      setCartera({ saldo: filas.reduce((a, x) => a + Number(x.saldo), 0), vencido: filas.filter((x) => x.vencimiento && x.vencimiento < hoy()).reduce((a, x) => a + Number(x.saldo), 0),
        clientes: new Set(filas.map((x) => x.cliente_id)).size });
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [desde, hasta, sucursal]);
  useEffect(() => { cargar(); }, [cargar]);

  const r = useMemo(() => {
    const total = (pagos ?? []).reduce((a, p) => a + Number(p.importe), 0);
    const agrupa = (k: (p: Pago) => string) => {
      const m = new Map<string, number>();
      for (const p of pagos ?? []) m.set(k(p), (m.get(k(p)) ?? 0) + Number(p.importe));
      return [...m.entries()].sort((a, b) => b[1] - a[1]);
    };
    const porCliente = new Map<string, { id: string; nombre: string; importe: number; pagos: number }>();
    let dias = 0, peso = 0;
    for (const p of pagos ?? []) {
      const v = p.ventas; if (!v) continue;
      const c = porCliente.get(v.cliente_id) ?? { id: v.cliente_id, nombre: v.clientes?.razon_social || v.clientes?.nombre || "—", importe: 0, pagos: 0 };
      c.importe += Number(p.importe); c.pagos += 1; porCliente.set(v.cliente_id, c);
      const d = Math.max(0, Math.round((new Date(`${dia(p.fecha)}T12:00:00`).getTime() - new Date(`${dia(v.fecha)}T12:00:00`).getTime()) / 86_400_000));
      dias += d * Number(p.importe); peso += Number(p.importe);
    }
    return { total, porForma: agrupa((p) => p.forma), porSucursal: agrupa((p) => p.ventas?.sucursales?.codigo ?? "—"), porDia: agrupa((p) => dia(p.fecha)).sort((a, b) => a[0].localeCompare(b[0])),
      clientes: [...porCliente.values()].sort((a, b) => b.importe - a.importe), diasPromedio: peso ? dias / peso : null };
  }, [pagos]);
  const maxDia = Math.max(1, ...r.porDia.map((x) => x[1]));

  const excel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Cobranza");
    const MON = '"$"#,##0.00';
    ws.addRow([`Cobranza del ${desde.split("-").reverse().join("/")} al ${hasta.split("-").reverse().join("/")}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
    ws.addRow([`Total cobrado: ${$(r.total)} · Por cobrar hoy: ${$(cartera.saldo)} · Vencido hoy: ${$(cartera.vencido)}`]);
    ws.addRow([]);
    const sec = (titulo: string, filas: [string, number][]) => {
      const h = ws.addRow([titulo, "Importe"]);
      h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
      for (const [k, v] of filas) ws.addRow([k, v]).getCell(2).numFmt = MON;
      ws.addRow([]);
    };
    sec("Cliente", r.clientes.map((c) => [c.nombre, c.importe]));
    sec("Forma de pago", r.porForma.map(([k, v]) => [FORMAS_PAGO[k] ?? k, v]));
    sec("Sucursal", r.porSucursal);
    sec("Día", r.porDia.map(([k, v]) => [k.split("-").reverse().join("/"), v]));
    ws.getColumn(1).width = 40; ws.getColumn(2).width = 16;
    await descargarLibro(wb, `cobranza-${desde}-a-${hasta}.xlsx`);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Reporte de cobranza</h1>
        <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" disabled={!pagos?.length} onClick={excel}>Descargar Excel</button>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Sucursal<select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
          <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}</select></label>
      </section>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 text-sm">
        {[["Cobrado en el periodo", $(r.total), "text-emerald-700"], ["Abonos", String(pagos?.length ?? 0), ""],
          ["Días promedio para pagar", r.diasPromedio == null ? "—" : `${Math.round(r.diasPromedio)} días`, ""],
          ["Por cobrar hoy", `${$(cartera.saldo)}`, "text-amber-700"], ["Vencido hoy", $(cartera.vencido), cartera.vencido > 0 ? "text-[var(--peligro)]" : ""]].map(([k, v, cl]) => (
          <div key={k} className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">{k}</div><div className={`text-xl font-semibold ${cl}`}>{v}</div></div>
        ))}
      </div>

      {cargando && !pagos ? <EsqueletoTabla columnas={3} filas={8} /> : (
        <div className="grid gap-4 lg:grid-cols-[1fr_320px] items-start">
          <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">Cliente</th><th className="font-normal text-right pr-3">Abonos</th><th className="font-normal text-right pr-3">Cobrado</th><th className="pr-2" /></tr></thead>
              <tbody>
                {r.clientes.map((c) => (
                  <tr key={c.id} className="border-b border-[var(--borde)]">
                    <td className="p-2">{c.nombre}</td><td className="pr-3 text-right">{c.pagos}</td><td className="pr-3 text-right">{$(c.importe)}</td>
                    <td className="pr-2 text-right"><Link className="underline text-xs" href={`/creditos/estado-de-cuenta?cliente=${c.id}`}>Estado de cuenta</Link></td>
                  </tr>
                ))}
                {!r.clientes.length && <tr><td colSpan={4} className="p-6 text-center text-[var(--tenue)]">No se cobró nada de cuentas por cobrar en el periodo.</td></tr>}
              </tbody>
            </table>
          </section>
          <aside className="flex flex-col gap-4 text-sm">
            <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3">
              <h2 className="font-medium mb-1">Por forma de pago</h2>
              {r.porForma.map(([k, v]) => <div key={k} className="flex justify-between px-2 py-1 odd:bg-[#f4f7f6]"><span>{FORMAS_PAGO[k] ?? k}</span><span>{$(v)}</span></div>)}
              {!r.porForma.length && <div className="text-[var(--tenue)]">—</div>}
            </div>
            {r.porSucursal.length > 1 && <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3">
              <h2 className="font-medium mb-1">Por sucursal</h2>
              {r.porSucursal.map(([k, v]) => <div key={k} className="flex justify-between px-2 py-1 odd:bg-[#f4f7f6]"><span>{k}</span><span>{$(v)}</span></div>)}
            </div>}
            {r.porDia.length > 0 && <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3">
              <h2 className="font-medium mb-2">Por día</h2>
              {r.porDia.map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 py-0.5">
                  <span className="w-12 text-xs text-[var(--tenue)]">{k.slice(8, 10)}/{k.slice(5, 7)}</span>
                  <div className="flex-1 h-2 rounded bg-[var(--resalte)]"><div className="h-2 rounded" style={{ width: `${(v / maxDia) * 100}%`, background: "var(--acento)" }} /></div>
                  <span className="w-24 text-right text-xs">{$(v)}</span>
                </div>
              ))}
            </div>}
          </aside>
        </div>
      )}
      <p className="text-xs text-[var(--tenue)]">Cobranza = pagos registrados después de la venta (abonos a notas a crédito o que quedaron con saldo). Lo cobrado al vender está en Pagos de clientes y en el Resumen contable.</p>
    </div>
  );
}
