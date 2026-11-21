"use client";
/**
 * Ventas › Cotizaciones: lista con filtros (como en las notas): # · Fecha · Cliente · Sucursal · Vigencia · Total · Estatus · Comentarios,
 * y acciones por renglón: ver, editar y generar venta. Cada usuario ve sus sucursales.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { estatusCotizacion } from "@/lib/cotizaciones";
import { EsqueletoFilas } from "@/components/Esqueleto";
import { BotonAccion } from "@/components/Iconos";

interface Fila {
  id: string; serie: string; folio: number; fecha: string; vigencia: string; estado: "borrador" | "enviada" | "convertida" | "cancelada";
  total: string; comentarios: string | null; prospecto: string | null; venta_id: string | null;
  sucursales: { codigo: string; nombre: string } | null; clientes: { nombre: string; razon_social: string | null } | null;
}
type Estatus = "" | "vigente" | "vencida" | "convertida" | "cancelada";

const POR_PAGINA = 50;
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const haceDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", tz); };
const fechaCorta = (iso: string) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString("es-MX", { ...tz, day: "2-digit", month: "2-digit", year: "numeric" });

export default function Cotizaciones() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [texto, setTexto] = useState("");
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState("");
  const [estatus, setEstatus] = useState<Estatus>("");
  const [pagina, setPagina] = useState(0);
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
      let q = sb.from("cotizaciones")
        .select("id, serie, folio, fecha, vigencia, estado, total, comentarios, prospecto, venta_id, sucursales(codigo, nombre), clientes(nombre, razon_social)", { count: "exact" })
        .order("fecha", { ascending: false }).range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      if (estatus === "vigente") q = q.in("estado", ["borrador", "enviada"]).gte("vigencia", hoy());
      if (estatus === "vencida") q = q.in("estado", ["borrador", "enviada"]).lt("vigencia", hoy());
      if (estatus === "convertida") q = q.eq("estado", "convertida");
      if (estatus === "cancelada") q = q.eq("estado", "cancelada");
      const t = texto.trim().replace(/[%,()]/g, "");
      if (t) {
        const folio = /^([A-Za-z]*)\s*-?\s*(\d+)$/.exec(t);
        if (folio) {
          q = q.eq("folio", Number(folio[2]));
          if (folio[1]) q = q.ilike("serie", folio[1]);
        } else {
          const { data: cl } = await sb.from("clientes").select("id").or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,rfc.ilike.%${t}%`).limit(200);
          const ids = ((cl ?? []) as { id: string }[]).map((c) => c.id);
          q = q.or(`prospecto.ilike.%${t}%${ids.length ? `,cliente_id.in.(${ids.join(",")})` : ""}`);
        }
      }
      const { data, error, count } = await q;
      if (error) throw error;
      setFilas((data ?? []) as unknown as Fila[]);
      setTotal(count ?? 0);
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [texto, desde, hasta, sucursal, estatus, pagina]);

  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [texto, desde, hasta, sucursal, estatus]);

  const sumaVigentes = filas.filter((f) => f.estado !== "cancelada").reduce((s, f) => s + Number(f.total), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Cotizaciones</h1>
        <Link href="/ventas/capturar?cotizar=1" className="btn-primario">+ Nueva cotización</Link>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end text-sm">
        <label className="lg:col-span-2">Buscar<input className="campo" placeholder="Folio (p. ej. AC 12) o cliente" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <label>Estatus
          <select className="campo" value={estatus} onChange={(e) => setEstatus(e.target.value as Estatus)}>
            <option value="">Todas</option><option value="vigente">Vigentes</option><option value="vencida">Vencidas</option>
            <option value="convertida">Convertidas en venta</option><option value="cancelada">Canceladas</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">#</th><th className="pr-3 font-normal">Fecha</th><th className="pr-3 font-normal">Cliente</th>
              <th className="pr-3 font-normal">Sucursal</th><th className="pr-3 font-normal">Vigencia</th><th className="pr-3 font-normal text-right">Total</th>
              <th className="pr-3 font-normal">Estatus</th><th className="pr-3 font-normal">Comentarios</th><th className="pr-2" />
            </tr>
          </thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={9} />}
            {filas.map((f, i) => {
              const e = estatusCotizacion(f);
              const abierta = f.estado === "borrador" || f.estado === "enviada";
              return (
                <tr key={f.id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb", opacity: f.estado === "cancelada" ? 0.6 : 1 }}>
                  <td className="p-2 whitespace-nowrap"><Link className="underline" href={`/ventas/cotizaciones/${f.id}`}>{f.serie} {f.folio}</Link></td>
                  <td className="pr-3 py-2 whitespace-nowrap">{fechaCorta(f.fecha)}</td>
                  <td className="pr-3 py-2">{f.clientes && !f.prospecto ? (f.clientes.razon_social || f.clientes.nombre) : f.prospecto || f.clientes?.nombre || "—"}</td>
                  <td className="pr-3 py-2">{f.sucursales ? `${f.sucursales.codigo} - ${f.sucursales.nombre}` : ""}</td>
                  <td className="pr-3 py-2 whitespace-nowrap">{fechaCorta(f.vigencia)}</td>
                  <td className="pr-3 py-2 text-right whitespace-nowrap">${fmtImporte(f.total)}</td>
                  <td className="pr-3 py-2"><span className={`inline-block px-1.5 rounded text-xs whitespace-nowrap ${e.cls}`} style={e.bg ? { background: e.bg } : undefined}>{e.txt}</span></td>
                  <td className="pr-3 py-2 max-w-[260px] text-xs">{f.comentarios}</td>
                  <td className="pr-2 py-1.5 whitespace-nowrap text-right">
                    <span className="inline-flex gap-1">
                      {abierta && <BotonAccion tipo="venta" titulo={`Generar venta de ${f.serie} ${f.folio}`} href={`/ventas/capturar?desde_cotizacion=${f.id}`} />}
                      {abierta && <BotonAccion tipo="editar" titulo={`Editar ${f.serie} ${f.folio}`} href={`/ventas/capturar?cotizacion=${f.id}`} />}
                      <BotonAccion tipo="abrir" titulo={`Ver detalle de ${f.serie} ${f.folio}`} href={`/ventas/cotizaciones/${f.id}`} />
                    </span>
                  </td>
                </tr>
              );
            })}
            {!cargando && filas.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-[var(--tenue)]">No hay cotizaciones con esos filtros.</td></tr>}
          </tbody>
        </table>
      </section>

      <div className="flex justify-between items-center flex-wrap gap-3 text-sm">
        <span className="text-[var(--tenue)]">{cargando ? "Cargando…" : `${total} cotización${total === 1 ? "" : "es"}`}
          {!cargando && filas.length > 0 && <> · En esta página (sin canceladas): ${fmtImporte(sumaVigentes)}</>}</span>
        {total > POR_PAGINA && (
          <div className="flex gap-3 items-center">
            <button className="underline disabled:opacity-40" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>← Anterior</button>
            <span>Página {pagina + 1} de {Math.ceil(total / POR_PAGINA)}</span>
            <button className="underline disabled:opacity-40" disabled={(pagina + 1) * POR_PAGINA >= total} onClick={() => setPagina((p) => p + 1)}>Siguiente →</button>
          </div>
        )}
      </div>
    </div>
  );
}
