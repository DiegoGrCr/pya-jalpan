"use client";
/**
 * Reportes › Inventarios:
 *  - Valorizado: existencias a costo promedio, agrupadas por almacén, marca, categoría o producto (valores solo con ver_costos).
 *  - Kardex: movimientos de un producto en un almacén y periodo, con entradas, salidas y saldo.
 * Ambos con Excel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte, nombreConCaja } from "@/lib/unidades";
import { fechaMx } from "@/lib/documentoVenta";
import { EsqueletoTabla } from "@/components/Esqueleto";
import ProductoBuscador, { ProductoSimple, textoBase } from "@/components/ProductoBuscador";
import { descargarLibro } from "@/lib/rol";

interface Ex { producto_id: string; almacen_id: string; cantidad: string; apartado: string;
  productos: { sku: string; nombre: string; unidad_base: string; costo_promedio: string | null; m2_por_caja?: string | null; formato?: string | null;
    marcas: { nombre: string } | null; categorias: { nombre: string } | null } | null;
  almacenes: { nombre: string; sucursales: { codigo: string } | null } | null }
interface Mov { id: number; fecha: string; tipo: string; cantidad: string; costo_unitario: string; saldo: string; documento_tipo: string; documento_id: string; nota: string | null; almacen_id: string }
type Grupo = "almacen" | "marca" | "categoria" | "producto";
const TIPOS: Record<string, string> = { inventario_inicial: "Inventario inicial", entrada: "Recepción", venta: "Venta", cancelacion_venta: "Cancelación de venta",
  devolucion: "Devolución de cliente", ajuste: "Ajuste", traspaso_salida: "Traspaso (sale)", traspaso_entrada: "Traspaso (entra)", cancelacion_traspaso: "Traspaso cancelado",
  cancelacion_entrada: "Recepción cancelada" };
const RUTA: Record<string, string> = { venta: "/ventas/", entrada: "/inventarios/recepcion/" };
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 7)}-01`;
const $ = (n: number) => `$${fmtImporte(n)}`;
const red = (n: number) => Math.round(n * 1000) / 1000;

export default function ReporteInventarios() {
  const [pestana, setPestana] = useState<"valorizado" | "kardex">("valorizado");
  const [costos, setCostos] = useState(false);
  const [almacenes, setAlmacenes] = useState<{ id: string; nombre: string; sucursales: { codigo: string } | null }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  // Valorizado
  const [almacen, setAlmacen] = useState("");
  const [grupo, setGrupo] = useState<Grupo>("marca");
  const [ex, setEx] = useState<Ex[] | null>(null);
  const [cargando, setCargando] = useState(false);
  // Kardex
  const [prod, setProd] = useState<ProductoSimple | null>(null);
  const [kAlm, setKAlm] = useState("");
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [movs, setMovs] = useState<Mov[] | null>(null);

  useEffect(() => {
    const sb = supabase();
    sb.from("almacenes").select("id, nombre, sucursales(codigo)").eq("activo", true).order("nombre").then(({ data }: { data: unknown }) => setAlmacenes((data ?? []) as typeof almacenes));
    sb.rpc("tiene_permiso", { p_permiso: "ver_costos" }).then(({ data }: { data: unknown }) => setCostos(data === true));
  }, []);
  const nomAlm = (id: string) => { const a = almacenes.find((x) => x.id === id); return a ? `${a.sucursales?.codigo ? `${a.sucursales.codigo} · ` : ""}${a.nombre}` : "—"; };

  const cargarValorizado = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const sb = supabase(); const todo: Ex[] = [];
      for (let i = 0; ; i += 1000) {
        let q = sb.from("existencias").select("producto_id, almacen_id, cantidad, apartado, productos!inner(sku, nombre, unidad_base, costo_promedio, tipo, m2_por_caja, formato, marcas(nombre), categorias(nombre)), almacenes(nombre, sucursales(codigo))")
          .eq("productos.tipo", "producto").neq("cantidad", 0).range(i, i + 999);
        if (almacen) q = q.eq("almacen_id", almacen);
        const { data, error } = await q;
        if (error) throw error;
        todo.push(...((data ?? []) as unknown as Ex[]));
        if (!data || data.length < 1000) break;
      }
      setEx(todo);
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [almacen]);
  useEffect(() => { if (pestana === "valorizado") cargarValorizado(); }, [pestana, cargarValorizado]);

  const grupos = useMemo(() => {
    const m = new Map<string, { nombre: string; productos: Set<string>; cantidad: number; valor: number; negativos: number; unidad: string }>();
    for (const e of ex ?? []) {
      const p = e.productos; if (!p) continue;
      const k = grupo === "almacen" ? e.almacen_id : grupo === "marca" ? p.marcas?.nombre ?? "Sin marca" : grupo === "categoria" ? p.categorias?.nombre ?? "Sin categoría" : `${e.producto_id}|${e.almacen_id}`;
      const nombre = grupo === "almacen" ? nomAlm(e.almacen_id) : grupo === "producto" ? `${p.sku} - ${nombreConCaja(p.nombre, p.m2_por_caja ?? null, p.formato ?? null)} · ${nomAlm(e.almacen_id)}` : k;
      const g = m.get(k) ?? { nombre, productos: new Set<string>(), cantidad: 0, valor: 0, negativos: 0, unidad: p.unidad_base };
      const c = Number(e.cantidad);
      g.productos.add(e.producto_id); g.cantidad += c;
      if (c > 0) g.valor += c * Number(p.costo_promedio ?? 0); else g.negativos += 1;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.valor - a.valor || a.nombre.localeCompare(b.nombre));
  }, [ex, grupo, almacenes]); // eslint-disable-line react-hooks/exhaustive-deps
  const totalValor = grupos.reduce((a, g) => a + g.valor, 0);
  const negativos = grupos.reduce((a, g) => a + g.negativos, 0);

  const cargarKardex = useCallback(async () => {
    if (!prod) return;
    setCargando(true); setMsg(null);
    try {
      let q = supabase().from("movimientos").select("id, fecha, tipo, cantidad, costo_unitario, saldo, documento_tipo, documento_id, nota, almacen_id")
        .eq("producto_id", prod.id).gte("fecha", `${desde}T00:00:00-06:00`).lte("fecha", `${hasta}T23:59:59.999-06:00`).order("fecha").order("id").limit(5000);
      if (kAlm) q = q.eq("almacen_id", kAlm);
      const { data, error } = await q;
      if (error) throw error;
      setMovs((data ?? []) as Mov[]);
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [prod, kAlm, desde, hasta]);
  useEffect(() => { if (pestana === "kardex") cargarKardex(); }, [pestana, cargarKardex]);

  const excel = async () => {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    if (pestana === "valorizado") {
      const ws = wb.addWorksheet("Inventario");
      ws.addRow([`Inventario ${costos ? "valorizado " : ""}al ${hoy().split("-").reverse().join("/")}${almacen ? ` · ${nomAlm(almacen)}` : ""}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
      ws.addRow([]);
      const h = ws.addRow(["Grupo", "Productos", "Cantidad (unidad base)", ...(costos ? ["Valor a costo"] : [])]);
      h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
      for (const g of grupos) ws.addRow([g.nombre, g.productos.size, red(g.cantidad), ...(costos ? [Math.round(g.valor * 100) / 100] : [])]);
      if (costos) ws.addRow(["Total", "", "", Math.round(totalValor * 100) / 100]).font = { bold: true };
      ws.columns.forEach((c, i) => { c.width = [60, 12, 20, 18][i]; });
      ws.getColumn(4).numFmt = '"$"#,##0.00';
    } else if (prod && movs) {
      const ws = wb.addWorksheet("Kardex");
      ws.addRow([`Kardex ${prod.sku} - ${prod.nombre}`]).font = { bold: true, size: 14, color: { argb: "FF0F766E" } };
      ws.addRow([`Del ${desde.split("-").reverse().join("/")} al ${hasta.split("-").reverse().join("/")}${kAlm ? ` · ${nomAlm(kAlm)}` : ""} · cantidades en ${prod.unidad_base}`]);
      ws.addRow([]);
      const h = ws.addRow(["Fecha", "Almacén", "Movimiento", "Nota", "Entrada", "Salida", "Saldo", ...(costos ? ["Costo unit."] : [])]);
      h.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F766E" } }; });
      for (const m of movs) { const c = Number(m.cantidad); const r = ws.addRow([new Date(m.fecha), nomAlm(m.almacen_id), TIPOS[m.tipo] ?? m.tipo, m.nota ?? "", c > 0 ? red(c) : null, c < 0 ? red(-c) : null, red(Number(m.saldo)), ...(costos ? [Number(m.costo_unitario)] : [])]); r.getCell(1).numFmt = "dd/mm/yyyy hh:mm"; }
      ws.columns.forEach((c, i) => { c.width = [17, 24, 22, 30, 11, 11, 11, 12][i]; });
    }
    await descargarLibro(wb, pestana === "valorizado" ? `inventario-${hoy()}.xlsx` : `kardex-${prod?.sku ?? ""}-${desde}-a-${hasta}.xlsx`);
  };

  const entradas = (movs ?? []).filter((m) => Number(m.cantidad) > 0).reduce((a, m) => a + Number(m.cantidad), 0);
  const salidas = (movs ?? []).filter((m) => Number(m.cantidad) < 0).reduce((a, m) => a - Number(m.cantidad), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Reporte de inventarios</h1>
        <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" disabled={pestana === "valorizado" ? !grupos.length : !movs?.length} onClick={excel}>Descargar Excel</button>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}
      <div className="flex gap-1 border-b border-[var(--borde)] text-sm">
        {([["valorizado", costos ? "Inventario valorizado" : "Inventario"], ["kardex", "Kardex de un producto"]] as const).map(([k, t]) => (
          <button key={k} onClick={() => setPestana(k)} className={`px-3 py-1.5 rounded-t border border-b-0 ${pestana === k ? "border-[var(--borde)] font-semibold bg-[var(--panel)]" : "border-transparent text-[var(--acento)]"}`}>{t}</button>
        ))}
      </div>

      {pestana === "valorizado" ? (<>
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
          <label>Almacén<select className="campo" value={almacen} onChange={(e) => setAlmacen(e.target.value)}>
            <option value="">Todos</option>{almacenes.map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}</select></label>
          <label>Agrupar por<select className="campo" value={grupo} onChange={(e) => setGrupo(e.target.value as Grupo)}>
            <option value="marca">Marca</option><option value="categoria">Categoría</option><option value="almacen">Almacén</option><option value="producto">Producto</option></select></label>
          {costos && <div className="ml-auto text-right"><div className="text-[var(--tenue)]">Valor total a costo promedio</div><div className="text-2xl font-semibold">{$(totalValor)}</div></div>}
        </section>
        {negativos > 0 && <div className="rounded px-4 py-2 bg-amber-50 text-amber-900 text-sm">Hay {negativos} existencia{negativos === 1 ? "" : "s"} en negativo (se vendió más de lo registrado): no suman al valor. Corrígelas con un conteo físico.</div>}
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          {cargando && !ex ? <div className="p-2"><EsqueletoTabla columnas={4} filas={10} /></div> : (
            <table className="w-full text-sm min-w-[600px]">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">{{ marca: "Marca", categoria: "Categoría", almacen: "Almacén", producto: "Producto" }[grupo]}</th>
                <th className="font-normal text-right pr-3">Productos</th>{grupo === "producto" && <th className="font-normal text-right pr-3">Existencia</th>}
                {costos && <th className="font-normal text-right pr-3">Valor</th>}{costos && <th className="font-normal text-right pr-2">% del total</th>}</tr></thead>
              <tbody>
                {grupos.map((g) => (
                  <tr key={g.nombre} className="border-b border-[var(--borde)]">
                    <td className="p-2">{g.nombre}{g.negativos > 0 && <span className="text-xs text-[var(--peligro)]"> · {g.negativos} en negativo</span>}</td>
                    <td className="pr-3 text-right">{g.productos.size}</td>
                    {grupo === "producto" && <td className={`pr-3 text-right ${g.cantidad < 0 ? "text-[var(--peligro)]" : ""}`}>{red(g.cantidad)} {g.unidad}</td>}
                    {costos && <td className="pr-3 text-right">{$(g.valor)}</td>}
                    {costos && <td className="pr-2 text-right text-[var(--tenue)]">{totalValor ? `${((g.valor / totalValor) * 100).toFixed(1)} %` : "—"}</td>}
                  </tr>
                ))}
                {!grupos.length && !cargando && <tr><td colSpan={5} className="p-6 text-center text-[var(--tenue)]">No hay existencias.</td></tr>}
              </tbody>
            </table>
          )}
        </section>
      </>) : (<>
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 items-end text-sm">
          <div className="sm:col-span-2">{prod ? <div className="flex items-center gap-2 py-2"><b>{prod.sku}</b> {nombreConCaja(prod.nombre, prod.m2_por_caja, prod.formato)}
            <button className="underline text-xs" onClick={() => { setProd(null); setMovs(null); }}>Cambiar</button></div>
            : <ProductoBuscador placeholder="Producto: código o nombre…" onElegir={setProd} />}</div>
          <label>Almacén<select className="campo" value={kAlm} onChange={(e) => setKAlm(e.target.value)}>
            <option value="">Todos</option>{almacenes.map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}</select></label>
          <div className="flex gap-2"><label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
            <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label></div>
        </section>
        {prod && movs && <div className="grid gap-3 grid-cols-3 text-sm">
          <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Entradas</div><div className="text-lg font-semibold text-emerald-700">{textoBase(prod, entradas)}</div></div>
          <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Salidas</div><div className="text-lg font-semibold text-[var(--peligro)]">{textoBase(prod, salidas)}</div></div>
          <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Movimientos</div><div className="text-lg font-semibold">{movs.length}</div></div>
        </div>}
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          {!prod ? <p className="p-6 text-center text-[var(--tenue)]">Elige un producto para ver sus movimientos.</p>
            : cargando && !movs ? <div className="p-2"><EsqueletoTabla columnas={6} filas={8} /></div> : (
            <table className="w-full text-sm min-w-[760px]">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="p-2 font-normal">Fecha</th><th className="font-normal">Almacén</th><th className="font-normal">Movimiento</th>
                <th className="font-normal text-right pr-3">Entrada</th><th className="font-normal text-right pr-3">Salida</th><th className="font-normal text-right pr-2">Saldo</th></tr></thead>
              <tbody>
                {(movs ?? []).map((m) => {
                  const c = Number(m.cantidad); const ruta = RUTA[m.documento_tipo];
                  return (
                    <tr key={m.id} className="border-b border-[var(--borde)] align-top">
                      <td className="p-2 whitespace-nowrap">{fechaMx(m.fecha)}</td><td className="py-2">{nomAlm(m.almacen_id)}</td>
                      <td className="py-2">{ruta ? <Link className="underline" href={`${ruta}${m.documento_id}`}>{TIPOS[m.tipo] ?? m.tipo}</Link> : TIPOS[m.tipo] ?? m.tipo}
                        {m.nota && <div className="text-xs text-[var(--tenue)]">{m.nota}</div>}</td>
                      <td className="py-2 pr-3 text-right text-emerald-700">{c > 0 ? textoBase(prod, c) : ""}</td>
                      <td className="py-2 pr-3 text-right text-[var(--peligro)]">{c < 0 ? textoBase(prod, -c) : ""}</td>
                      <td className={`py-2 pr-2 text-right ${Number(m.saldo) < 0 ? "text-[var(--peligro)] font-semibold" : ""}`}>{textoBase(prod, Number(m.saldo))}</td>
                    </tr>
                  );
                })}
                {movs && !movs.length && <tr><td colSpan={6} className="p-6 text-center text-[var(--tenue)]">Sin movimientos en el periodo.</td></tr>}
              </tbody>
            </table>
          )}
        </section>
        {!kAlm && prod && <p className="text-xs text-[var(--tenue)]">Con «Todos los almacenes», el saldo de cada renglón es el de su propio almacén.</p>}
      </>)}
    </div>
  );
}
