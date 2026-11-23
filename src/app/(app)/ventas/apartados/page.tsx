"use client";
/**
 * Ventas › Apartados: material reservado para un cliente (no sale del inventario hasta liquidarse).
 * Lista con filtros, días abierto (aviso a los N días de empresa.apartado_dias_aviso), lo abonado y el saldo;
 * acciones: liquidar (convertir en venta) y abrir el detalle (abonar, imprimir, cancelar).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { EsqueletoFilas } from "@/components/Esqueleto";
import { BotonAccion } from "@/components/Iconos";

interface Fila {
  id: string; serie: string; folio: number; fecha: string; estado: "abierto" | "liquidado" | "cancelado";
  total: string; abonado: string; saldo: string; comentarios: string | null; venta_id: string | null;
  sucursales: { codigo: string; nombre: string } | null; clientes: { nombre: string; razon_social: string | null; telefono: string | null } | null;
}
type Estatus = "" | "abierto" | "viejo" | "liquidado" | "cancelado";

const POR_PAGINA = 50;
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const fechaCorta = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { ...tz, day: "2-digit", month: "2-digit", year: "numeric" });
const diasDesde = (iso: string) => {
  const f = new Date(iso).toLocaleDateString("en-CA", tz);
  return Math.round((new Date(`${hoy()}T12:00:00`).getTime() - new Date(`${f}T12:00:00`).getTime()) / 86_400_000);
};
const haceDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", tz); };

export default function Apartados() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [aviso, setAviso] = useState(15);
  const [texto, setTexto] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [sucursal, setSucursal] = useState("");
  const [estatus, setEstatus] = useState<Estatus>("abierto");
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const sb = supabase();
    sb.from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
    sb.from("empresa").select("apartado_dias_aviso").eq("id", 1).maybeSingle()
      .then(({ data }: { data: unknown }) => { const d = (data as { apartado_dias_aviso?: number } | null)?.apartado_dias_aviso; if (d) setAviso(d); });
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const sb = supabase();
      let q = sb.from("apartados")
        .select("id, serie, folio, fecha, estado, total, abonado, saldo, comentarios, venta_id, sucursales(codigo, nombre), clientes(nombre, razon_social, telefono)", { count: "exact" })
        .order("fecha", { ascending: estatus === "abierto" || estatus === "viejo" }).range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      if (estatus === "abierto") q = q.eq("estado", "abierto");
      if (estatus === "viejo") q = q.eq("estado", "abierto").lte("fecha", `${haceDias(aviso)}T23:59:59.999-06:00`);
      if (estatus === "liquidado") q = q.eq("estado", "liquidado");
      if (estatus === "cancelado") q = q.eq("estado", "cancelado");
      const t = texto.trim().replace(/[%,()]/g, "");
      if (t) {
        const folio = /^([A-Za-z]*)\s*-?\s*(\d+)$/.exec(t);
        if (folio) {
          q = q.eq("folio", Number(folio[2]));
          if (folio[1]) q = q.ilike("serie", folio[1]);
        } else {
          const { data: cl } = await sb.from("clientes").select("id").or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,telefono.ilike.%${t}%`).limit(200);
          const ids = ((cl ?? []) as { id: string }[]).map((c) => c.id);
          q = q.in("cliente_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]);
        }
      }
      const { data, error, count } = await q;
      if (error) throw error;
      setFilas((data ?? []) as unknown as Fila[]);
      setTotal(count ?? 0);
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [texto, desde, hasta, sucursal, estatus, pagina, aviso]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [texto, desde, hasta, sucursal, estatus]);

  const abiertos = filas.filter((f) => f.estado === "abierto");
  const porCobrar = abiertos.reduce((s, f) => s + Number(f.saldo), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Apartados</h1>
        <Link href="/ventas/capturar?apartar=1" className="btn-primario">+ Nuevo apartado</Link>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end text-sm">
        <label className="lg:col-span-2">Buscar<input className="campo" placeholder="Folio, cliente o teléfono" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <label>Estatus
          <select className="campo" value={estatus} onChange={(e) => setEstatus(e.target.value as Estatus)}>
            <option value="abierto">Abiertos</option><option value="viejo">Abiertos con {aviso} días o más</option>
            <option value="liquidado">Liquidados (vendidos)</option><option value="cancelado">Cancelados</option><option value="">Todos</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">#</th><th className="pr-3 font-normal">Fecha</th><th className="pr-3 font-normal">Cliente</th>
              <th className="pr-3 font-normal">Sucursal</th><th className="pr-3 font-normal text-right">Total</th><th className="pr-3 font-normal text-right">Abonado</th>
              <th className="pr-3 font-normal text-right">Saldo</th><th className="pr-3 font-normal">Estatus</th><th className="pr-2" />
            </tr>
          </thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={9} />}
            {filas.map((f, i) => {
              const dias = diasDesde(f.fecha);
              const viejo = f.estado === "abierto" && dias >= aviso;
              return (
                <tr key={f.id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb", opacity: f.estado === "cancelado" ? 0.6 : 1 }}>
                  <td className="p-2 whitespace-nowrap"><Link className="underline" href={`/ventas/apartados/${f.id}`}>{f.serie} {f.folio}</Link></td>
                  <td className="pr-3 py-2 whitespace-nowrap">{fechaCorta(f.fecha)}</td>
                  <td className="pr-3 py-2">{f.clientes?.razon_social || f.clientes?.nombre || "—"}
                    {f.clientes?.telefono && <div className="text-xs text-[var(--tenue)]">{f.clientes.telefono}</div>}</td>
                  <td className="pr-3 py-2">{f.sucursales ? `${f.sucursales.codigo} - ${f.sucursales.nombre}` : ""}</td>
                  <td className="pr-3 py-2 text-right whitespace-nowrap">${fmtImporte(f.total)}</td>
                  <td className="pr-3 py-2 text-right whitespace-nowrap">{Number(f.abonado) > 0 ? `$${fmtImporte(f.abonado)}` : <span className="text-[var(--tenue)]">Sin anticipo</span>}</td>
                  <td className={`pr-3 py-2 text-right whitespace-nowrap ${f.estado === "abierto" ? "font-semibold text-amber-700" : ""}`}>{f.estado === "abierto" ? `$${fmtImporte(f.saldo)}` : "—"}</td>
                  <td className="pr-3 py-2"><EstatusApartado estado={f.estado} dias={dias} viejo={viejo} /></td>
                  <td className="pr-2 py-1.5 whitespace-nowrap text-right">
                    <span className="inline-flex gap-1">
                      {f.estado === "abierto" && <BotonAccion tipo="venta" titulo={`Liquidar ${f.serie} ${f.folio} (convertir en venta)`} href={`/ventas/capturar?liquidar=${f.id}`} />}
                      <BotonAccion tipo="abrir" titulo={`Ver detalle de ${f.serie} ${f.folio}`} href={`/ventas/apartados/${f.id}`} />
                    </span>
                  </td>
                </tr>
              );
            })}
            {!cargando && filas.length === 0 && <tr><td colSpan={9} className="p-6 text-center text-[var(--tenue)]">No hay apartados con esos filtros.</td></tr>}
          </tbody>
        </table>
      </section>

      <div className="flex justify-between items-center flex-wrap gap-3 text-sm">
        <span className="text-[var(--tenue)]">{cargando ? "Cargando…" : `${total} apartado${total === 1 ? "" : "s"}`}
          {!cargando && abiertos.length > 0 && <> · Por cobrar en esta página: ${fmtImporte(porCobrar)}</>}</span>
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

function EstatusApartado({ estado, dias, viejo }: { estado: Fila["estado"]; dias: number; viejo: boolean }) {
  if (estado === "liquidado") return <span className="inline-block px-1.5 rounded text-xs bg-emerald-100 text-emerald-900">Liquidado</span>;
  if (estado === "cancelado") return <span className="inline-block px-1.5 rounded text-xs bg-gray-200 text-gray-700">Cancelado</span>;
  return (
    <span className={`inline-block px-1.5 rounded text-xs whitespace-nowrap ${viejo ? "bg-red-100 text-red-800 font-semibold" : "bg-amber-100 text-amber-900"}`}
      title={viejo ? "Lleva muchos días apartado: comunícate con el cliente" : undefined}>
      Abierto · {dias === 0 ? "hoy" : `${dias} día${dias === 1 ? "" : "s"}`}{viejo ? " ⚠" : ""}
    </span>
  );
}
