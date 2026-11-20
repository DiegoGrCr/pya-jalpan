"use client";
/**
 * Finanzas › Gastos: lo que se pagó con dinero de las sucursales (renta, fletes, sueldos…), con filtros
 * y totales por categoría y forma de pago. Se registran desde el corte de caja (+ Registrar gasto).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { CATEGORIAS_GASTO, FORMAS_GASTO } from "@/lib/gastos";
import { EsqueletoFilas } from "@/components/Esqueleto";

interface Fila {
  id: string; fecha: string; importe: string; concepto: string; categoria: string | null; forma: string; proveedor: string | null;
  usuario_id: string | null; cancelado: boolean; corte_id: string | null; sucursales: { codigo: string; nombre: string } | null;
}
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 7)}-01`;
const $ = (n: number | string) => `$${fmtImporte(Number(n))}`;

export default function Gastos() {
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [sucursal, setSucursal] = useState("");
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [categoria, setCategoria] = useState("");
  const [forma, setForma] = useState("");
  const [texto, setTexto] = useState("");
  const [filas, setFilas] = useState<Fila[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo");
      setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]);
    })();
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      let q = supabase().from("retiros_caja")
        .select("id, fecha, importe, concepto, categoria, forma, proveedor, usuario_id, cancelado, corte_id, sucursales(codigo, nombre)")
        .eq("tipo", "gasto").eq("cancelado", false).order("fecha", { ascending: false }).limit(1000);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (categoria) q = q.eq("categoria", categoria);
      if (forma) q = q.eq("forma", forma);
      const { data, error } = await q;
      if (error) {
        if (/tipo|categoria|forma|proveedor/.test(error.message)) throw new Error("Falta ejecutar la migración 20261119000040_gastos.sql en Supabase.");
        if (/retiros_caja/.test(error.message)) throw new Error("Falta ejecutar la migración 20261119000039_corte_caja.sql en Supabase.");
        throw error;
      }
      let f = (data ?? []) as unknown as Fila[];
      const t = texto.trim().toLowerCase();
      if (t) f = f.filter((x) => `${x.concepto} ${x.proveedor ?? ""} ${x.categoria ?? ""}`.toLowerCase().includes(t));
      setFilas(f);
      const ids = f.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [sucursal, desde, hasta, categoria, forma, texto]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);

  const total = useMemo(() => filas.reduce((s, x) => s + Number(x.importe), 0), [filas]);
  const porCategoria = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of filas) m.set(x.categoria ?? "Sin categoría", (m.get(x.categoria ?? "Sin categoría") ?? 0) + Number(x.importe));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filas]);
  const porForma = useMemo(() => FORMAS_GASTO.map((f) => [f, filas.filter((x) => x.forma === f).reduce((s, x) => s + Number(x.importe), 0)] as const), [filas]);
  const max = porCategoria[0]?.[1] ?? 1;

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Gastos</h1>
        <Link href="/finanzas/corte" className="btn-primario">+ Registrar gasto (en el corte de caja)</Link>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="Concepto o proveedor" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Categoría
          <select className="campo" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
            <option value="">Todas</option>{CATEGORIAS_GASTO.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label>Forma de pago
          <select className="campo" value={forma} onChange={(e) => setForma(e.target.value)}>
            <option value="">Todas</option>{FORMAS_GASTO.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f]}</option>)}
          </select>
        </label>
      </section>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px] items-start">
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          <table className="w-full text-sm min-w-[820px]">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">Fecha</th><th className="pr-3 font-normal">Sucursal</th><th className="pr-3 font-normal">Categoría</th>
                <th className="pr-3 font-normal">Concepto</th><th className="pr-3 font-normal">Forma</th>
                <th className="pr-3 font-normal text-right">Importe</th><th className="pr-2 font-normal">Registró</th>
              </tr>
            </thead>
            <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={7} />}
              {filas.map((x, i) => (
                <tr key={x.id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb" }}>
                  <td className="p-2 whitespace-nowrap">{fechaMx(x.fecha)}</td>
                  <td className="pr-3 py-2 whitespace-nowrap">{x.sucursales?.codigo ?? ""}</td>
                  <td className="pr-3 py-2 whitespace-nowrap">{x.categoria ?? "—"}</td>
                  <td className="pr-3 py-2">{x.concepto}{x.proveedor && <div className="text-xs text-[var(--tenue)]">{x.proveedor}</div>}</td>
                  <td className="pr-3 py-2 whitespace-nowrap">{FORMAS_PAGO[x.forma] ?? x.forma}</td>
                  <td className="pr-3 py-2 text-right whitespace-nowrap">{$(x.importe)}</td>
                  <td className="pr-2 py-2">{x.usuario_id ? nombres[x.usuario_id] ?? "" : ""}
                    {!x.corte_id && <div className="text-xs text-[var(--tenue)]">Corte en curso</div>}</td>
                </tr>
              ))}
              {!cargando && filas.length === 0 && <tr><td colSpan={7} className="p-6 text-center text-[var(--tenue)]">No hay gastos con esos filtros.</td></tr>}
            </tbody>
          </table>
        </section>

        <aside className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 text-sm flex flex-col gap-4">
          <div>
            <div className="text-[var(--tenue)]">Total de gastos</div>
            <div className="text-2xl font-semibold">{$(total)}</div>
            <div className="text-xs text-[var(--tenue)]">{filas.length} gasto{filas.length === 1 ? "" : "s"}</div>
          </div>
          <div>
            <h2 className="font-medium mb-2">Por categoría</h2>
            {porCategoria.length === 0 ? <div className="text-[var(--tenue)]">—</div> : (
              <ul className="flex flex-col gap-2">
                {porCategoria.map(([c, v]) => (
                  <li key={c}>
                    <div className="flex justify-between"><span>{c}</span><span>{$(v)}</span></div>
                    <div className="h-1.5 rounded bg-[var(--resalte)]"><div className="h-1.5 rounded" style={{ width: `${(v / max) * 100}%`, background: "var(--acento)" }} /></div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h2 className="font-medium mb-1">Por forma de pago</h2>
            {porForma.map(([f, v]) => (
              <div key={f} className="flex justify-between px-2 py-1 odd:bg-[#f4f7f6]"><span>{FORMAS_PAGO[f]}</span><span>{$(v)}</span></div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
