"use client";
/**
 * Ventas › Lista de ventas. Acomodo como en las notas: filtros arriba y tabla con
 * # · Tipo · Fecha · Cliente · Sucursal · Almacén · Vencimiento · Subtotal · Impuestos · Total · Pendiente · Estatus · Detalle.
 * Muestra solo las sucursales del usuario (RLS).
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { TIPO_VENTA, fmtImporte } from "@/lib/unidades";
import { nombresUsuarios } from "@/lib/documentoVenta";
import EstatusVenta from "@/components/EstatusVenta";
import { EsqueletoFilas } from "@/components/Esqueleto";
import { BotonAccion } from "@/components/Iconos";

interface Fila {
  id: string; serie: string; folio: number; fecha: string; tipo: "contado" | "credito"; estado: "confirmada" | "cancelada";
  subtotal: string; descuento: string; iva: string; ieps: string; total: string; saldo: string; vencimiento: string | null; vendedor_id: string | null;
  sucursales: { codigo: string; nombre: string } | null; almacenes: { nombre: string } | null; clientes: { nombre: string; razon_social: string | null } | null;
  venta_partidas: { cantidad: string; cantidad_entregada: string }[];
  cerrada?: boolean;
}
interface Sucursal { id: string; codigo: string; nombre: string }

const POR_PAGINA = 50;
const hoyMx = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); // AAAA-MM-DD
const haceDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); };
const fechaCorta = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric" });

export default function ListaVentas() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [vendedores, setVendedores] = useState<Record<string, string>>({});
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [texto, setTexto] = useState("");
  const [desde, setDesde] = useState(haceDias(30));
  const [hasta, setHasta] = useState(hoyMx());
  const [sucursal, setSucursal] = useState("");
  const [estatus, setEstatus] = useState<"" | "abierta" | "pagada_abierta" | "cerrada" | "cancelada" | "pendiente_pago" | "pendiente_entrega">("");
  const [tipo, setTipo] = useState<"" | "contado" | "abono" | "credito">("");
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());   // para agendar un envío con varias notas

  useEffect(() => {
    (async () => {
      const { data } = await supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo");
      setSucursales((data ?? []) as Sucursal[]);
    })();
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const sb = supabase();
      let q = sb.from("ventas")
        .select("id, serie, folio, fecha, tipo, estado, subtotal, descuento, iva, ieps, total, saldo, vencimiento, vendedor_id, cerrada, sucursales(codigo, nombre), almacenes(nombre), clientes(nombre, razon_social), venta_partidas(cantidad, cantidad_entregada)", { count: "exact" })
        .order("fecha", { ascending: false }).range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
      // Fechas en hora del centro de México
      if (desde) q = q.gte("fecha", `${desde}T00:00:00-06:00`);
      if (hasta) q = q.lte("fecha", `${hasta}T23:59:59.999-06:00`);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      if (tipo === "credito") q = q.eq("tipo", "credito");
      if (tipo === "contado") q = q.eq("tipo", "contado").eq("con_abono", false);
      if (tipo === "abono") q = q.eq("tipo", "contado").eq("con_abono", true);
      if (estatus === "abierta") q = q.eq("estado", "confirmada").eq("cerrada", false);
      if (estatus === "pagada_abierta") q = q.eq("estado", "confirmada").eq("cerrada", false).lte("saldo", 0);
      if (estatus === "cerrada") q = q.eq("estado", "confirmada").eq("cerrada", true);
      if (estatus === "cancelada") q = q.eq("estado", "cancelada");
      if (estatus === "pendiente_pago") q = q.eq("estado", "confirmada").gt("saldo", 0);
      const t = texto.trim().replace(/[%,()]/g, "");
      if (t) {
        const folio = /^([A-Za-z]*)\s*-?\s*(\d+)$/.exec(t);
        if (folio) {
          q = q.eq("folio", Number(folio[2]));
          if (folio[1]) q = q.ilike("serie", folio[1]);
        } else {
          const { data: cl } = await sb.from("clientes").select("id").or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,rfc.ilike.%${t}%`).limit(200);
          q = q.in("cliente_id", ((cl ?? []) as { id: string }[]).map((c) => c.id).concat("00000000-0000-0000-0000-000000000000"));
        }
      }
      const { data, error, count } = await q;
      if (error) {
        if (/cerrada/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000027_ventas_editables.sql en Supabase.");
        throw error;
      }
      let f = (data ?? []) as unknown as Fila[];
      // Entrega pendiente se calcula con los renglones (filtro sobre la página cargada)
      if (estatus === "pendiente_entrega") f = f.filter((x) => x.estado === "confirmada" && x.venta_partidas.some((p) => Number(p.cantidad_entregada) < Number(p.cantidad)));
      setFilas(f);
      setTotal(count ?? 0);
      setVendedores(await nombresUsuarios(f.map((x) => x.vendedor_id ?? "")));
    } catch (e) { setMsg(mensajeError(e)); }
    finally { setCargando(false); }
  }, [texto, desde, hasta, sucursal, estatus, tipo, pagina]);

  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [texto, desde, hasta, sucursal, estatus, tipo]);

  const suma = (k: "total" | "saldo") => filas.filter((f) => f.estado === "confirmada").reduce((s, f) => s + Number(f[k]), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Ventas</h1>
        <div className="flex gap-2 items-center">
          {marcadas.size > 0 && <Link href={`/agenda?nuevo=1&ventas=${[...marcadas].join(",")}`} className="px-3 py-2 rounded border border-[var(--acento)] text-[var(--acento)] text-sm">
            Agendar envío con {marcadas.size} nota{marcadas.size === 1 ? "" : "s"}</Link>}
          <Link href="/ventas/capturar" className="btn-primario">+ Capturar venta</Link>
        </div>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end text-sm">
        <label className="lg:col-span-2">Buscar
          <input className="campo" placeholder="Folio (p. ej. PV120) o cliente / RFC" value={texto} onChange={(e) => setTexto(e.target.value)} />
        </label>
        <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
        <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        <label>Sucursal
          <select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label>Estatus
            <select className="campo" value={estatus} onChange={(e) => setEstatus(e.target.value as typeof estatus)}>
              <option value="">Todas</option><option value="abierta">Abiertas</option><option value="pagada_abierta">Pagadas sin cerrar</option>
              <option value="cerrada">Cerradas</option><option value="pendiente_pago">Con saldo</option>
              <option value="pendiente_entrega">Por entregar</option><option value="cancelada">Canceladas</option>
            </select>
          </label>
          <label>Tipo
            <select className="campo" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
              <option value="">Todas</option>{(["contado", "abono", "credito"] as const).map((k) => <option key={k} value={k}>{TIPO_VENTA[k].largo}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[1100px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="pl-2 w-6"><span className="sr-only">Elegir para agendar</span></th><th className="p-2 font-normal">#</th><th className="pr-3 font-normal">Tipo</th><th className="pr-3 font-normal">Fecha</th>
              <th className="pr-3 font-normal">Cliente</th><th className="pr-3 font-normal">Sucursal</th><th className="pr-3 font-normal">Almacén</th>
              <th className="pr-3 font-normal">Capturó</th><th className="pr-3 font-normal">Vencimiento</th>
              <th className="pr-3 font-normal text-right">Subtotal</th><th className="pr-3 font-normal text-right">Impuestos</th>
              <th className="pr-3 font-normal text-right">Total</th><th className="pr-3 font-normal text-right">Pendiente</th>
              <th className="pr-3 font-normal">Estatus</th><th className="pr-2 font-normal text-center">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={15} />}
            {filas.map((f, i) => {
              const cancelada = f.estado === "cancelada";
              const sinEntregar = !cancelada && f.venta_partidas.some((p) => Number(p.cantidad_entregada) < Number(p.cantidad));
              return (
                <tr key={f.id} className="border-b border-[var(--borde)]" style={{ background: i % 2 ? "transparent" : "#f7f9fb", opacity: cancelada ? 0.6 : 1 }}>
                  <td className="pl-2">{!cancelada && <input type="checkbox" title="Elegir para agendar un envío" aria-label={`Elegir ${f.serie} ${f.folio}`} checked={marcadas.has(f.id)}
                    onChange={(e) => setMarcadas((m) => { const n = new Set(m); if (e.target.checked) n.add(f.id); else n.delete(f.id); return n; })} />}</td>
                  <td className="p-2 whitespace-nowrap"><Link className="underline" href={`/ventas/${f.id}`}>{f.serie} {f.folio}</Link></td>
                  <td className="pr-3">Remisión</td>
                  <td className="pr-3 whitespace-nowrap">{fechaCorta(f.fecha)}</td>
                  <td className="pr-3">{f.clientes?.razon_social || f.clientes?.nombre}</td>
                  <td className="pr-3">{f.sucursales ? `${f.sucursales.codigo} - ${f.sucursales.nombre}` : ""}</td>
                  <td className="pr-3">{f.almacenes?.nombre}</td>
                  <td className="pr-3">{f.vendedor_id ? vendedores[f.vendedor_id] ?? "" : ""}</td>
                  <td className="pr-3 whitespace-nowrap">{f.vencimiento ? fechaCorta(`${f.vencimiento}T12:00:00`) : fechaCorta(f.fecha)}</td>
                  <td className="pr-3 text-right whitespace-nowrap">${fmtImporte(Number(f.subtotal) + Number(f.descuento))}</td>
                  <td className="pr-3 text-right whitespace-nowrap">${fmtImporte(Number(f.iva) + Number(f.ieps))}</td>
                  <td className="pr-3 text-right whitespace-nowrap">${fmtImporte(f.total)}</td>
                  <td className="pr-3 text-right whitespace-nowrap">{cancelada ? "" : `$${fmtImporte(f.saldo)}`}</td>
                  <td className="pr-3"><EstatusVenta estado={f.estado} saldo={f.saldo} cerrada={f.cerrada} porEntregar={sinEntregar} /></td>
                  <td className="pr-2 text-center">
                    <BotonAccion tipo="abrir" titulo={`Ver detalle de ${f.serie} ${f.folio}`} href={`/ventas/${f.id}`} />
                  </td>
                </tr>
              );
            })}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={15} className="p-6 text-center text-[var(--tenue)]">No hay ventas con esos filtros.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="flex justify-between items-center flex-wrap gap-3 text-sm">
        <span className="text-[var(--tenue)]">
          {cargando ? "Cargando…" : `${total} venta${total === 1 ? "" : "s"}`}
          {!cargando && filas.length > 0 && <> · En esta página (sin canceladas): total ${fmtImporte(suma("total"))}, pendiente ${fmtImporte(suma("saldo"))}</>}
        </span>
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
