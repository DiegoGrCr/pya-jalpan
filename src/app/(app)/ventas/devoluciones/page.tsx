"use client";
/**
 * Ventas › Devoluciones: historial de devoluciones de material (qué se regresó, de qué venta y cliente,
 * importe y si quedó a favor o se devolvió el dinero). Se registran desde el detalle de la venta.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { EsqueletoFilas } from "@/components/Esqueleto";

interface Fila {
  id: string; fecha: string; destino: "saldo_favor" | "dinero"; forma: string | null; importe: string; motivo: string; usuario_id: string | null;
  partidas: { producto: string; unidad: string; cantidad: number; importe: number }[];
  ventas: { id: string; serie: string; folio: number; sucursales: { codigo: string; nombre: string } | null; clientes: { nombre: string; razon_social: string | null } | null } | null;
}
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const haceDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", tz); };

export default function Devoluciones() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [destino, setDestino] = useState<"" | "saldo_favor" | "dinero">("");
  const [texto, setTexto] = useState("");
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      let q = supabase().from("devoluciones_producto")
        .select("id, fecha, destino, forma, importe, motivo, usuario_id, partidas, ventas(id, serie, folio, sucursales(codigo, nombre), clientes(nombre, razon_social))")
        .order("fecha", { ascending: false }).limit(500);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (destino) q = q.eq("destino", destino);
      const { data, error } = await q;
      if (error) {
        if (/devoluciones_producto/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000038_cartera_devoluciones.sql en Supabase.");
        throw error;
      }
      let f = (data ?? []) as unknown as Fila[];
      const t = texto.trim().toLowerCase();
      if (t) f = f.filter((x) => `${x.ventas?.serie} ${x.ventas?.folio} ${x.ventas?.serie}${x.ventas?.folio} ${x.ventas?.clientes?.razon_social ?? ""} ${x.ventas?.clientes?.nombre ?? ""} ${x.partidas.map((p) => p.producto).join(" ")} ${x.motivo}`.toLowerCase().includes(t));
      setFilas(f);
      const ids = f.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [desde, hasta, destino, texto]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);

  const suma = (d: string) => filas.filter((x) => x.destino === d).reduce((s, x) => s + Number(x.importe), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Devoluciones de material</h1>
        <span className="text-sm text-[var(--tenue)]">Se registran desde la venta: Acciones › Devolver productos</span>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="Folio de venta, cliente, producto o motivo" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Destino
          <select className="campo" value={destino} onChange={(e) => setDestino(e.target.value as typeof destino)}>
            <option value="">Todos</option><option value="saldo_favor">A saldo a favor</option><option value="dinero">Dinero devuelto</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">Fecha</th><th className="pr-3 font-normal">Venta</th><th className="pr-3 font-normal">Cliente</th>
              <th className="pr-3 font-normal">Material devuelto</th><th className="pr-3 font-normal">Motivo</th>
              <th className="pr-3 font-normal text-right">Importe</th><th className="pr-3 font-normal">Destino</th><th className="pr-2 font-normal">Registró</th>
            </tr>
          </thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={8} />}
            {filas.map((x, i) => (
              <tr key={x.id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb" }}>
                <td className="p-2 whitespace-nowrap">{fechaMx(x.fecha)}</td>
                <td className="pr-3 py-2 whitespace-nowrap">{x.ventas ? <Link className="underline" href={`/ventas/${x.ventas.id}`}>{x.ventas.serie} {x.ventas.folio}</Link> : "—"}
                  <div className="text-xs text-[var(--tenue)]">{x.ventas?.sucursales ? `${x.ventas.sucursales.codigo} - ${x.ventas.sucursales.nombre}` : ""}</div></td>
                <td className="pr-3 py-2">{x.ventas?.clientes?.razon_social || x.ventas?.clientes?.nombre || "—"}</td>
                <td className="pr-3 py-2">{x.partidas.map((p, j) => <div key={j}>{fmtCantidad(p.cantidad)} {p.unidad} · {p.producto}</div>)}</td>
                <td className="pr-3 py-2">{x.motivo}</td>
                <td className="pr-3 py-2 text-right whitespace-nowrap">${fmtImporte(x.importe)}</td>
                <td className="pr-3 py-2">{x.destino === "saldo_favor"
                  ? <span className="px-1.5 rounded text-xs bg-emerald-100 text-emerald-900">A saldo a favor</span>
                  : <span className="px-1.5 rounded text-xs bg-amber-100 text-amber-900">Devuelto · {FORMAS_PAGO[x.forma ?? ""] ?? x.forma}</span>}</td>
                <td className="pr-2 py-2">{x.usuario_id ? nombres[x.usuario_id] ?? "" : ""}</td>
              </tr>
            ))}
            {!cargando && filas.length === 0 && <tr><td colSpan={8} className="p-6 text-center text-[var(--tenue)]">No hay devoluciones con esos filtros.</td></tr>}
          </tbody>
        </table>
      </section>
      {!cargando && filas.length > 0 && (
        <div className="text-sm text-[var(--tenue)]">{filas.length} devolución{filas.length === 1 ? "" : "es"} · A saldo a favor ${fmtImporte(suma("saldo_favor"))} · Dinero devuelto ${fmtImporte(suma("dinero"))}</div>
      )}
    </div>
  );
}
