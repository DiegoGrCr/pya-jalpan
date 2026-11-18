"use client";
/**
 * Reportes › Ventas › Histórico. Acomodo como en las notas: panel de filtros plegable,
 * tabla # · Fecha · Cliente · Costo · Utilidad · Subtotal · Descuento · IVA · Total · Pagos · Saldo · Estatus,
 * totales, "Agrupar por" y exportar a Excel. Cada usuario ve solo sus sucursales.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";
import { nombresUsuarios } from "@/lib/documentoVenta";
import EstatusVenta from "@/components/EstatusVenta";

interface Venta {
  id: string; serie: string; folio: number; fecha: string; cliente: string | null; cliente_id: string | null; sucursal: string | null; almacen: string | null;
  vendedor_id: string | null; tipo: "contado" | "credito"; con_abono: boolean; estado: string; estatus: "pagada" | "activa" | "cancelada";
  subtotal: string; descuento: string; iva: string; ieps: string; total: string; pagado: string; saldo: string; costo: string;
  orden_compra: string | null; comentarios: string | null; cerrada?: boolean;
}
interface Partida {
  venta_id: string; fecha: string; estado: string; producto_id: string; sku: string; producto: string; formato: string | null;
  m2_por_caja: string | null; piezas_por_caja: number | null; categoria: string | null; marca: string | null; unidad_base: string;
  cantidad_base: string; total: string; descuento: string; costo: string;
}
interface Opcion { id: string; nombre: string }
type Agrupar = "" | "cliente" | "vendedor" | "sucursal" | "almacen" | "mes" | "dia" | "estatus" | "tipo" | "producto" | "categoria" | "marca";

const AGRUPAR: [Agrupar, string][] = [["", "Sin agrupar"], ["cliente", "Cliente"], ["vendedor", "Vendedor (capturó)"], ["sucursal", "Sucursal"],
  ["almacen", "Almacén"], ["mes", "Mes"], ["dia", "Día"], ["estatus", "Estatus"], ["tipo", "Tipo de venta"], ["producto", "Producto"],
  ["categoria", "Categoría"], ["marca", "Marca"]];
const POR_PARTIDA: Agrupar[] = ["producto", "categoria", "marca"];
const ESTATUS = { pagada: ["Pagada", "bg-emerald-100 text-emerald-900"], activa: ["Con saldo", "bg-amber-100 text-amber-900"], cancelada: ["Cancelada", "text-white"] } as const;
const cierreDe = (v: Venta) => v.estatus === "cancelada" || v.cerrada == null ? "" : v.cerrada ? "Cerrada" : "Abierta";

const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 8)}01`;
const fechaCorta = (iso: string) => new Date(iso).toLocaleDateString("es-MX", { ...tz, day: "2-digit", month: "short", year: "numeric" });
const n = (x: string | number | null | undefined) => Number(x ?? 0);
const $ = (x: number) => `$${fmtImporte(x)}`;
const tipoDe = (v: Venta) => (v.tipo === "credito" ? "Crédito" : v.con_abono ? "Contado con abono" : "Contado");

const FILTROS_VACIOS = {
  desde: inicioMes(), hasta: hoy(), sucursal_id: "", almacen_id: "", vendedor_id: "", cliente: "", estatus: "", cierre: "", tipo: "",
  producto: "", categoria_id: "", marca_id: "", orden_compra: "", serie: "", comentario: "",
};

export default function ReporteVentas() {
  const [f, setF] = useState(FILTROS_VACIOS);
  const [agrupar, setAgrupar] = useState<Agrupar>("");
  const [abierto, setAbierto] = useState(true);
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [partidas, setPartidas] = useState<Partida[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [sucursales, setSucursales] = useState<Opcion[]>([]);
  const [almacenes, setAlmacenes] = useState<Opcion[]>([]);
  const [categorias, setCategorias] = useState<Opcion[]>([]);
  const [marcas, setMarcas] = useState<Opcion[]>([]);
  const [cargando, setCargando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pagina, setPagina] = useState(0);
  const [porPagina, setPorPagina] = useState(50);
  const [expandido, setExpandido] = useState<string | null>(null);
  const [orden, setOrden] = useState<{ k: string; asc: boolean }>({ k: "fecha", asc: false });

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const [s, a, c, m] = await Promise.all([
        sb.from("sucursales").select("id, codigo, nombre").order("codigo"),
        sb.from("almacenes").select("id, nombre").order("nombre"),
        sb.from("categorias").select("id, nombre").order("nombre"),
        sb.from("marcas").select("id, nombre").order("nombre"),
      ]);
      setSucursales(((s.data ?? []) as { id: string; codigo: string; nombre: string }[]).map((x) => ({ id: x.id, nombre: `${x.codigo} - ${x.nombre}` })));
      setAlmacenes((a.data ?? []) as Opcion[]);
      setCategorias((c.data ?? []) as Opcion[]);
      setMarcas((m.data ?? []) as Opcion[]);
    })();
  }, []);

  const buscar = useCallback(async () => {
    setCargando(true); setMsg(null); setPagina(0); setExpandido(null);
    try {
      const sb = supabase();
      const p = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== ""));
      const [v, pt] = await Promise.all([
        sb.rpc("reporte_ventas", { p }),
        POR_PARTIDA.includes(agrupar) ? sb.rpc("reporte_ventas_partidas", { p }) : Promise.resolve({ data: [], error: null }),
      ]);
      for (const r of [v, pt]) if (r.error) {
        if (/reporte_ventas/.test(r.error.message)) throw new Error("Falta ejecutar la migración 20261118000026_reporte_ventas.sql en Supabase.");
        throw r.error;
      }
      const vs = (v.data ?? []) as Venta[];
      setVentas(vs);
      setPartidas((pt.data ?? []) as Partida[]);
      const ids = [...new Set(vs.map((x) => x.vendedor_id ?? "").filter(Boolean))].filter((id) => !nombres[id]);
      if (ids.length) { const nn = await nombresUsuarios(ids); setNombres((x) => ({ ...x, ...nn })); }
    } catch (e) { setMsg(mensajeError(e)); }
    finally { setCargando(false); }
  }, [f, agrupar]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { buscar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (POR_PARTIDA.includes(agrupar) && ventas.length && !partidas.length) buscar(); }, [agrupar]); // eslint-disable-line react-hooks/exhaustive-deps

  const vendedores: Opcion[] = useMemo(() => Object.entries(nombres).map(([id, nombre]) => ({ id, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre)), [nombres]);
  const validas = ventas.filter((v) => v.estatus !== "cancelada" || f.estatus === "cancelada");
  const tot = useMemo(() => {
    const s = { costo: 0, subtotal: 0, descuento: 0, iva: 0, ieps: 0, total: 0, pagado: 0, saldo: 0 };
    for (const v of validas) for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] += n(v[k]);
    return s;
  }, [validas]);
  const conIeps = ventas.some((v) => n(v.ieps) > 0);

  // Orden y paginación de la tabla sin agrupar
  const ordenadas = useMemo(() => {
    const val = (v: Venta): number | string => orden.k === "fecha" ? v.fecha : orden.k === "cliente" ? (v.cliente ?? "") : orden.k === "folio" ? v.folio
      : orden.k === "utilidad" ? n(v.subtotal) - n(v.descuento) - n(v.costo) : n(v[orden.k as keyof Venta] as string);
    return [...ventas].sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (orden.asc ? 1 : -1); });
  }, [ventas, orden]);
  const visibles = ordenadas.slice(pagina * porPagina, (pagina + 1) * porPagina);

  // Grupos
  const grupos = useMemo(() => {
    if (!agrupar) return [];
    const mapa = new Map<string, { clave: string; nombre: string; ventas: Set<string>; cantidad: number; m2: number; subtotal: number; descuento: number; total: number; pagado: number; saldo: number; costo: number; detalle: Venta[] }>();
    const nuevo = (clave: string, nombre: string) => {
      if (!mapa.has(clave)) mapa.set(clave, { clave, nombre, ventas: new Set(), cantidad: 0, m2: 0, subtotal: 0, descuento: 0, total: 0, pagado: 0, saldo: 0, costo: 0, detalle: [] });
      return mapa.get(clave)!;
    };
    if (POR_PARTIDA.includes(agrupar)) {
      for (const p of partidas) {
        if (p.estado === "cancelada" && f.estatus !== "cancelada") continue;
        const [clave, nombre] = agrupar === "producto" ? [p.producto_id, `${p.sku} · ${nombreConCaja(p.producto, p.m2_por_caja, p.formato)}`]
          : agrupar === "categoria" ? [p.categoria ?? "", p.categoria ?? "Sin categoría"] : [p.marca ?? "", p.marca ?? "Sin marca"];
        const g = nuevo(clave, nombre);
        g.ventas.add(p.venta_id); g.cantidad += n(p.cantidad_base); g.total += n(p.total); g.descuento += n(p.descuento);
        g.subtotal += n(p.total) + n(p.descuento); g.costo += n(p.costo);
        if (p.m2_por_caja && p.piezas_por_caja) g.m2 += n(p.cantidad_base) * n(p.m2_por_caja) / p.piezas_por_caja;
      }
    } else {
      for (const v of validas) {
        const fecha = new Date(v.fecha);
        const [clave, nombre] =
          agrupar === "cliente" ? [v.cliente_id ?? "", v.cliente ?? "—"]
          : agrupar === "vendedor" ? [v.vendedor_id ?? "", (v.vendedor_id && nombres[v.vendedor_id]) || "Sin asignar"]
          : agrupar === "sucursal" ? [v.sucursal ?? "", v.sucursal ?? "—"]
          : agrupar === "almacen" ? [v.almacen ?? "", v.almacen ?? "—"]
          : agrupar === "mes" ? [fecha.toLocaleDateString("en-CA", tz).slice(0, 7), fecha.toLocaleDateString("es-MX", { ...tz, month: "long", year: "numeric" })]
          : agrupar === "dia" ? [fecha.toLocaleDateString("en-CA", tz), fecha.toLocaleDateString("es-MX", { ...tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" })]
          : agrupar === "estatus" ? [`${v.estatus}${cierreDe(v)}`, [ESTATUS[v.estatus][0], cierreDe(v)].filter(Boolean).join(" · ")]
          : [tipoDe(v), tipoDe(v)];
        const g = nuevo(clave, nombre);
        g.ventas.add(v.id); g.subtotal += n(v.subtotal); g.descuento += n(v.descuento); g.total += n(v.total);
        g.pagado += n(v.pagado); g.saldo += n(v.saldo); g.costo += n(v.costo); g.detalle.push(v);
      }
    }
    const lista = [...mapa.values()];
    return agrupar === "mes" || agrupar === "dia" ? lista.sort((a, b) => b.clave.localeCompare(a.clave)) : lista.sort((a, b) => b.total - a.total);
  }, [agrupar, partidas, validas, nombres, f.estatus]);

  const exportar = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Ventas");
    if (agrupar) {
      const porPartida = POR_PARTIDA.includes(agrupar);
      ws.columns = [{ header: AGRUPAR.find((x) => x[0] === agrupar)![1], key: "nombre", width: 45 }, { header: "Ventas", key: "ventas", width: 10 },
        ...(porPartida ? [{ header: "Cantidad (unidad base)", key: "cantidad", width: 18 }, { header: "M²", key: "m2", width: 12 }] : []),
        { header: "Subtotal", key: "subtotal", width: 14 }, { header: "Descuento", key: "descuento", width: 14 }, { header: "Total", key: "total", width: 14 },
        ...(porPartida ? [] : [{ header: "Pagos", key: "pagado", width: 14 }, { header: "Saldo", key: "saldo", width: 14 }]),
        { header: "Costo", key: "costo", width: 14 }, { header: "Utilidad", key: "utilidad", width: 14 }];
      for (const g of grupos) ws.addRow({ ...g, ventas: g.ventas.size, m2: Math.round(g.m2 * 100) / 100, utilidad: g.subtotal - g.descuento - g.costo });
    } else {
      ws.columns = [{ header: "#", key: "folio", width: 12 }, { header: "Fecha", key: "fecha", width: 18 }, { header: "Cliente", key: "cliente", width: 32 },
        { header: "Sucursal", key: "sucursal", width: 22 }, { header: "Almacén", key: "almacen", width: 18 }, { header: "Capturó", key: "capturo", width: 20 },
        { header: "Tipo", key: "tipo", width: 16 }, { header: "Costo", key: "costo", width: 12 }, { header: "Utilidad", key: "utilidad", width: 12 },
        { header: "Subtotal", key: "subtotal", width: 12 }, { header: "Descuento", key: "descuento", width: 12 }, { header: "IVA", key: "iva", width: 10 },
        { header: "Total", key: "total", width: 12 }, { header: "Pagos", key: "pagado", width: 12 }, { header: "Saldo", key: "saldo", width: 12 },
        { header: "Estatus", key: "estatus", width: 12 }, { header: "Orden de compra", key: "orden_compra", width: 16 }, { header: "Comentarios", key: "comentarios", width: 30 }];
      for (const v of ordenadas) ws.addRow({
        folio: `${v.serie} ${v.folio}`, fecha: new Date(v.fecha).toLocaleString("es-MX", tz), cliente: v.cliente, sucursal: v.sucursal, almacen: v.almacen,
        capturo: v.vendedor_id ? nombres[v.vendedor_id] ?? "" : "", tipo: tipoDe(v), costo: n(v.costo), utilidad: n(v.subtotal) - n(v.descuento) - n(v.costo),
        subtotal: n(v.subtotal), descuento: n(v.descuento), iva: n(v.iva), total: n(v.total), pagado: n(v.pagado), saldo: n(v.saldo),
        estatus: [ESTATUS[v.estatus][0], cierreDe(v)].filter(Boolean).join(" · "), orden_compra: v.orden_compra ?? "", comentarios: v.comentarios ?? "",
      });
    }
    ws.getRow(1).font = { bold: true };
    ws.eachRow((r, i) => { if (i > 1) r.eachCell((c) => { if (typeof c.value === "number") c.numFmt = "#,##0.00"; }); });
    const b = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(b);
    Object.assign(document.createElement("a"), { href: url, download: `reporte-ventas-${f.desde}-a-${f.hasta}.xlsx` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const Encabezado = ({ k, t, der }: { k: string; t: string; der?: boolean }) => (
    <th className={`font-normal pr-3 py-1 ${der ? "text-right" : ""}`}>
      <button className="hover:underline" onClick={() => setOrden((o) => ({ k, asc: o.k === k ? !o.asc : false }))}>{t}{orden.k === k ? (orden.asc ? " ▲" : " ▼") : " ⇕"}</button>
    </th>
  );
  const Sel = ({ k, opciones, todos = "Todos" }: { k: keyof typeof f; opciones: Opcion[]; todos?: string }) => (
    <select className="campo" value={f[k]} onChange={(e) => set(k, e.target.value)}>
      <option value="">{todos}</option>{opciones.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
    </select>
  );

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold" style={{ color: "var(--acento)" }}>Reporte de Ventas</h1>
        <button className="btn-primario" disabled={!ventas.length} onClick={exportar}>Exportar a Excel</button>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      {/* Filtros */}
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] text-sm" style={{ borderLeft: "4px solid var(--acento)" }}>
        <button className="w-full flex justify-between items-center px-4 py-2 text-[var(--acento)]" onClick={() => setAbierto(!abierto)}>
          <span>Filtros</span><span>{abierto ? "▴" : "▾"}</span>
        </button>
        {abierto && (
          <div className="px-4 pb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6 items-end">
            <label>Cliente<input className="campo" placeholder="Nombre o RFC" value={f.cliente} onChange={(e) => set("cliente", e.target.value)} /></label>
            <label>Vendedor (capturó)<Sel k="vendedor_id" opciones={vendedores} /></label>
            <label>Sucursal<Sel k="sucursal_id" opciones={sucursales} todos="Todas" /></label>
            <label>Almacén<Sel k="almacen_id" opciones={almacenes} /></label>
            <label>Producto<input className="campo" placeholder="SKU o nombre" value={f.producto} onChange={(e) => set("producto", e.target.value)} /></label>
            <label>Categoría<Sel k="categoria_id" opciones={categorias} todos="Todas" /></label>
            <label>Marca<Sel k="marca_id" opciones={marcas} todos="Todas" /></label>
            <label>Desde<input type="date" className="campo" value={f.desde} onChange={(e) => set("desde", e.target.value)} /></label>
            <label>Hasta<input type="date" className="campo" value={f.hasta} onChange={(e) => set("hasta", e.target.value)} /></label>
            <label>Estatus
              <select className="campo" value={f.estatus} onChange={(e) => set("estatus", e.target.value)}>
                <option value="">Todos</option><option value="pagada">Pagada</option><option value="pagada_abierta">Pagada sin cerrar</option>
                <option value="activa">Con saldo</option><option value="cancelada">Cancelada</option>
              </select>
            </label>
            <label>Cierre
              <select className="campo" value={f.cierre} onChange={(e) => set("cierre", e.target.value)}>
                <option value="">Todas</option><option value="abierta">Abiertas</option><option value="cerrada">Cerradas</option>
              </select>
            </label>
            <label>Tipo de venta
              <select className="campo" value={f.tipo} onChange={(e) => set("tipo", e.target.value)}>
                <option value="">Todos</option><option value="contado">Contado</option><option value="abono">Contado con abono</option><option value="credito">Crédito</option>
              </select>
            </label>
            <label>Orden de compra<input className="campo" value={f.orden_compra} onChange={(e) => set("orden_compra", e.target.value)} /></label>
            <label>Serie<input className="campo" placeholder="p. ej. PV" value={f.serie} onChange={(e) => set("serie", e.target.value)} /></label>
            <label>Comentario<input className="campo" value={f.comentario} onChange={(e) => set("comentario", e.target.value)} /></label>
            <label>Agrupar por
              <select className="campo" value={agrupar} onChange={(e) => { setAgrupar(e.target.value as Agrupar); setExpandido(null); }}>
                {AGRUPAR.map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            </label>
            <div className="flex gap-2 lg:col-span-2 justify-end">
              <button className="px-3 py-2 underline" onClick={() => { setF(FILTROS_VACIOS); setAgrupar(""); }}>Limpiar</button>
              <button className="btn-primario" disabled={cargando} onClick={buscar}>{cargando ? "Buscando…" : "Buscar"}</button>
            </div>
          </div>
        )}
      </section>

      {/* Resumen */}
      {!cargando && ventas.length > 0 && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 justify-end text-sm">
          <span>{validas.length} venta{validas.length === 1 ? "" : "s"}{ventas.length !== validas.length ? ` (+${ventas.length - validas.length} canceladas)` : ""}</span>
          <span>Total: <b>{$(tot.total)}</b></span><span>Pagos: <b>{$(tot.pagado)}</b></span><span>Saldo: <b>{$(tot.saldo)}</b></span>
          <span>Utilidad: <b>{$(tot.subtotal - tot.descuento - tot.costo)}</b></span>
        </div>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        {cargando ? <div className="p-6 text-center text-[var(--tenue)]">Cargando…</div>
          : !ventas.length ? <div className="m-4 p-3 rounded text-center bg-amber-50 text-amber-900">No se encontraron registros, ajusta los filtros y vuelve a intentarlo.</div>
          : agrupar ? (
            <table className="w-full text-sm min-w-[860px]">
              <thead style={{ color: "var(--acento)" }}>
                <tr className="text-left border-b border-[var(--borde)]">
                  <th className="font-normal p-2">{AGRUPAR.find((x) => x[0] === agrupar)![1]}</th><th className="font-normal pr-3 text-right">Ventas</th>
                  {POR_PARTIDA.includes(agrupar) && <><th className="font-normal pr-3 text-right">Cantidad</th><th className="font-normal pr-3 text-right">M²</th></>}
                  <th className="font-normal pr-3 text-right">Subtotal</th><th className="font-normal pr-3 text-right">Descuento</th><th className="font-normal pr-3 text-right">Total</th>
                  {!POR_PARTIDA.includes(agrupar) && <><th className="font-normal pr-3 text-right">Pagos</th><th className="font-normal pr-3 text-right">Saldo</th></>}
                  <th className="font-normal pr-3 text-right">Costo</th><th className="font-normal pr-2 text-right">Utilidad</th>
                </tr>
              </thead>
              <tbody>
                {grupos.map((g, i) => (
                  <Fragment key={g.clave + i}>
                    <tr className={`border-b border-[var(--borde)] ${g.detalle.length ? "cursor-pointer hover:bg-[var(--resalte)]" : ""}`} style={{ background: i % 2 ? undefined : "#f7f9fb" }}
                      onClick={() => g.detalle.length && setExpandido(expandido === g.clave ? null : g.clave)}>
                      <td className="p-2">{g.detalle.length ? (expandido === g.clave ? "▾ " : "▸ ") : ""}{g.nombre}</td>
                      <td className="pr-3 text-right">{g.ventas.size}</td>
                      {POR_PARTIDA.includes(agrupar) && <><td className="pr-3 text-right">{fmtCantidad(g.cantidad, 2)}</td><td className="pr-3 text-right">{g.m2 ? fmtCantidad(g.m2, 2) : ""}</td></>}
                      <td className="pr-3 text-right">{$(g.subtotal)}</td><td className="pr-3 text-right">{$(g.descuento)}</td><td className="pr-3 text-right font-medium">{$(g.total)}</td>
                      {!POR_PARTIDA.includes(agrupar) && <><td className="pr-3 text-right">{$(g.pagado)}</td><td className="pr-3 text-right">{$(g.saldo)}</td></>}
                      <td className="pr-3 text-right">{$(g.costo)}</td><td className="pr-2 text-right">{$(g.subtotal - g.descuento - g.costo)}</td>
                    </tr>
                    {expandido === g.clave && g.detalle.map((v) => (
                      <tr key={v.id} className="border-b border-[var(--borde)] text-xs bg-white">
                        <td className="pl-8 py-1"><Link className="underline" href={`/ventas/${v.id}`}>{v.serie} {v.folio}</Link> · {fechaCorta(v.fecha)} · {v.cliente}</td>
                        <td /><td /><td /><td className="pr-3 text-right">{$(n(v.total))}</td><td className="pr-3 text-right">{$(n(v.pagado))}</td><td className="pr-3 text-right">{$(n(v.saldo))}</td><td /><td />
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm min-w-[1100px]">
              <thead style={{ color: "var(--acento)" }}>
                <tr className="text-left border-b border-[var(--borde)]">
                  <th className="font-normal p-2"><button className="hover:underline" onClick={() => setOrden((o) => ({ k: "folio", asc: o.k === "folio" ? !o.asc : false }))}># ⇕</button></th>
                  <Encabezado k="fecha" t="Fecha" /><Encabezado k="cliente" t="Cliente" /><Encabezado k="costo" t="Costo" der /><Encabezado k="utilidad" t="Utilidad" der />
                  <Encabezado k="subtotal" t="Subtotal" der /><Encabezado k="descuento" t="Descuento" der /><Encabezado k="iva" t="IVA" der />
                  {conIeps && <Encabezado k="ieps" t="IEPS" der />}
                  <Encabezado k="total" t="Total" der /><Encabezado k="pagado" t="Pagos" der /><Encabezado k="saldo" t="Saldo" der />
                  <th className="font-normal pr-3">Estatus</th><th className="font-normal pr-2"></th>
                </tr>
              </thead>
              <tbody>
                {visibles.map((v, i) => {
                  return (
                    <tr key={v.id} className="border-b border-[var(--borde)]" style={{ background: i % 2 ? undefined : "#f7f9fb" }}>
                      <td className="p-2 whitespace-nowrap">{v.serie} {v.folio}</td>
                      <td className="pr-3 whitespace-nowrap">{fechaCorta(v.fecha)}</td>
                      <td className="pr-3">{v.cliente}</td>
                      <td className="pr-3 text-right">{$(n(v.costo))}</td>
                      <td className="pr-3 text-right">{$(n(v.subtotal) - n(v.descuento) - n(v.costo))}</td>
                      <td className="pr-3 text-right">{$(n(v.subtotal))}</td><td className="pr-3 text-right">{$(n(v.descuento))}</td>
                      <td className="pr-3 text-right">{$(n(v.iva))}</td>{conIeps && <td className="pr-3 text-right">{$(n(v.ieps))}</td>}
                      <td className="pr-3 text-right">{$(n(v.total))}</td><td className="pr-3 text-right">{$(n(v.pagado))}</td><td className="pr-3 text-right">{$(n(v.saldo))}</td>
                      <td className="pr-3"><EstatusVenta estado={v.estado} saldo={v.saldo} cerrada={v.cerrada} /></td>
                      <td className="pr-2">
                        <Link href={`/ventas/${v.id}`} title="Ver detalle" aria-label={`Ver ${v.serie} ${v.folio}`}
                          className="inline-flex items-center justify-center w-7 h-7 rounded border border-[var(--acento)] text-[var(--acento)] hover:bg-[var(--resalte)]">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
                <tr className="font-semibold">
                  <td className="p-2" colSpan={3}>Totales{ventas.length !== validas.length ? " (sin canceladas)" : ""}</td>
                  <td className="pr-3 text-right">{$(tot.costo)}</td><td className="pr-3 text-right">{$(tot.subtotal - tot.descuento - tot.costo)}</td>
                  <td className="pr-3 text-right">{$(tot.subtotal)}</td><td className="pr-3 text-right">{$(tot.descuento)}</td><td className="pr-3 text-right">{$(tot.iva)}</td>
                  {conIeps && <td className="pr-3 text-right">{$(tot.ieps)}</td>}
                  <td className="pr-3 text-right">{$(tot.total)}</td><td className="pr-3 text-right">{$(tot.pagado)}</td><td className="pr-3 text-right">{$(tot.saldo)}</td><td /><td />
                </tr>
              </tbody>
            </table>
          )}
      </section>

      {!agrupar && ventas.length > porPagina && (
        <div className="flex justify-end items-center gap-3 text-sm flex-wrap">
          <span className="text-[var(--tenue)]">{ventas.length} resultados</span>
          <button className="underline disabled:opacity-40" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>← Anterior</button>
          <span>Página {pagina + 1} de {Math.ceil(ventas.length / porPagina)}</span>
          <button className="underline disabled:opacity-40" disabled={(pagina + 1) * porPagina >= ventas.length} onClick={() => setPagina((p) => p + 1)}>Siguiente →</button>
          <select className="campo !w-auto" value={porPagina} onChange={(e) => { setPorPagina(Number(e.target.value)); setPagina(0); }}>
            {[20, 50, 100, 200].map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
