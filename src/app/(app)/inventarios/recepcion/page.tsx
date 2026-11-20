"use client";
/**
 * Inventarios › Recepción de mercancía: entradas de proveedor (folio, proveedor, factura o remisión,
 * almacén, total al costo, estado). Cada entrada sube existencias y actualiza el costo promedio.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { fechaMx, nombresUsuarios } from "@/lib/documentoVenta";

interface Fila {
  id: string; serie: string; folio: number; fecha: string; documento_proveedor: string | null; estado: "aplicada" | "cancelada";
  total: string; subtotal: string; iva: string; tipo_documento: string | null; usuario_id: string | null; proveedores: { nombre: string } | null; almacenes: { nombre: string } | null;
  sucursales: { codigo: string } | null;
}
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const haceDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", tz); };

export default function Recepcion() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [texto, setTexto] = useState("");
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      let q = supabase().from("entradas")
        .select("id, serie, folio, fecha, documento_proveedor, estado, total, subtotal, iva, tipo_documento, usuario_id, proveedores(nombre), almacenes(nombre), sucursales(codigo)")
        .order("fecha", { ascending: false }).limit(500);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      const { data, error } = await q;
      if (error) {
        if (/total|subtotal|tipo_documento/.test(error.message)) throw new Error("Falta ejecutar la migración 20261120000047_recepcion_mercancia.sql en Supabase.");
        throw error;
      }
      let f = (data ?? []) as unknown as Fila[];
      const t = texto.trim().toLowerCase();
      if (t) f = f.filter((x) => `${x.serie} ${x.folio} ${x.serie}${x.folio} ${x.proveedores?.nombre ?? ""} ${x.documento_proveedor ?? ""}`.toLowerCase().includes(t));
      setFilas(f);
      const ids = f.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [desde, hasta, texto]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);

  const total = filas.filter((x) => x.estado === "aplicada").reduce((s, x) => s + Number(x.total), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Recepción de mercancía</h1>
        <Link href="/inventarios/recepcion/nueva" className="btn-primario">+ Nueva recepción</Link>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-[2fr_1fr_1fr] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="Folio, proveedor o factura" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
      </section>
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Folio</th><th className="font-normal">Fecha</th><th className="font-normal">Proveedor</th>
            <th className="font-normal">Documento</th><th className="font-normal">Almacén</th><th className="font-normal text-right pr-3">Subtotal</th>
            <th className="font-normal text-right pr-3">I.V.A.</th><th className="font-normal text-right pr-3">Total</th>
            <th className="font-normal">Estado</th><th className="font-normal">Recibió</th></tr></thead>
          <tbody>
            {filas.map((x) => (
              <tr key={x.id} className="border-b border-[var(--borde)]">
                <td className="p-2 whitespace-nowrap"><Link className="underline" href={`/inventarios/recepcion/${x.id}`}>{x.serie} {x.folio}</Link></td>
                <td className="whitespace-nowrap pr-3">{fechaMx(x.fecha)}</td>
                <td className="pr-3">{x.proveedores?.nombre ?? "—"}</td>
                <td className="pr-3">{x.tipo_documento ? { factura: "Factura", remision: "Remisión", otro: "Otro" }[x.tipo_documento] ?? "" : ""} {x.documento_proveedor ?? ""}</td>
                <td className="pr-3">{x.sucursales?.codigo ? `${x.sucursales.codigo} · ` : ""}{x.almacenes?.nombre}</td>
                <td className="text-right pr-3 whitespace-nowrap">${fmtImporte(x.subtotal)}</td>
                <td className="text-right pr-3 whitespace-nowrap">${fmtImporte(x.iva)}</td>
                <td className="text-right pr-3 whitespace-nowrap">${fmtImporte(x.total)}</td>
                <td>{x.estado === "cancelada"
                  ? <span className="px-1.5 rounded text-xs bg-gray-200 text-gray-700">Cancelada</span>
                  : <span className="px-1.5 rounded text-xs bg-emerald-100 text-emerald-900">Aplicada</span>}</td>
                <td>{x.usuario_id ? nombres[x.usuario_id] ?? "" : ""}</td>
              </tr>
            ))}
            {!cargando && !filas.length && <tr><td colSpan={10} className="p-6 text-center text-[var(--tenue)]">No hay recepciones con esos filtros.</td></tr>}
          </tbody>
        </table>
      </section>
      {!cargando && filas.length > 0 && <div className="text-sm text-[var(--tenue)]">{filas.length} recepcion{filas.length === 1 ? "" : "es"} · Total recibido (con IVA) ${fmtImporte(total)}</div>}
    </div>
  );
}
