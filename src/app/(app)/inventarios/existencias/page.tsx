"use client";
/**
 * Inventarios › Almacenes y existencias.
 * Vista general: existencia total por producto y una columna por bodega (la suma, sin "almacén general").
 * Con una bodega elegida: existencia, apartado y disponible de esa bodega.
 * Pisos en cajas + piezas y m²; lo demás en su unidad. Exportar a Excel.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";

interface Fila {
  producto_id: string; sku: string; nombre: string; formato: string | null; presentacion: string; unidad_base: string;
  piezas_por_caja: number | null; m2_por_caja: string | null; marca: string | null; categoria: string | null; activo: boolean;
  costo: string; total: string; apartado: string; por_almacen: { almacen_id: string; cantidad: number; apartado: number }[]; total_filas: number;
}
interface Opcion { id: string; nombre: string }
interface Almacen extends Opcion { sucursal: string; activo: boolean }

const POR_PAGINA = 50;
const n = (x: string | number | null | undefined) => Number(x ?? 0);

/** "12 cj + 3 pz" para pisos; "25 BULTO" para lo demás */
function cantidadTxt(f: Pick<Fila, "piezas_por_caja" | "unidad_base" | "presentacion">, cant: number): string {
  if (f.presentacion === "piso" && f.piezas_por_caja) {
    const neg = cant < 0, a = Math.abs(cant), cj = Math.trunc(a / f.piezas_por_caja), pz = a - cj * f.piezas_por_caja;
    return `${neg ? "−" : ""}${fmtCantidad(cj, 0)} cj${pz ? ` + ${fmtCantidad(pz, 2)} pz` : ""}`;
  }
  return `${fmtCantidad(cant, 2)} ${f.unidad_base}`;
}
const m2Txt = (f: Pick<Fila, "piezas_por_caja" | "m2_por_caja">, cant: number) =>
  f.m2_por_caja && f.piezas_por_caja ? `${fmtCantidad(cant * n(f.m2_por_caja) / f.piezas_por_caja, 2)} m²` : "";

export default function Existencias() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [marcas, setMarcas] = useState<Opcion[]>([]);
  const [categorias, setCategorias] = useState<Opcion[]>([]);
  const [f, setF] = useState({ texto: "", marca_id: "", categoria_id: "", almacen_id: "", filtro: "con" });
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const [a, m, c] = await Promise.all([
        sb.from("almacenes").select("id, nombre, activo, sucursales!almacenes_sucursal_id_fkey(codigo)").order("nombre"),
        sb.from("marcas").select("id, nombre").order("nombre"),
        sb.from("categorias").select("id, nombre").order("nombre"),
      ]);
      setAlmacenes(((a.data ?? []) as unknown as { id: string; nombre: string; activo: boolean; sucursales: { codigo: string } | null }[])
        .map((x) => ({ id: x.id, nombre: x.nombre, activo: x.activo, sucursal: x.sucursales?.codigo ?? "" })));
      setMarcas((m.data ?? []) as Opcion[]);
      setCategorias((c.data ?? []) as Opcion[]);
    })();
  }, []);

  const consulta = useCallback(async (limite: number, desplazamiento: number) => {
    const p = { ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")), limite, desplazamiento };
    const { data, error } = await supabase().rpc("existencias_consulta", { p });
    if (error) {
      if (/existencias_consulta/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000032_existencias.sql en Supabase.");
      throw error;
    }
    return (data ?? []) as Fila[];
  }, [f]);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const d = await consulta(POR_PAGINA, pagina * POR_PAGINA);
      setFilas(d); setTotal(d[0]?.total_filas ?? 0);
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [consulta, pagina]);

  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [f]);

  // Columnas de bodega: las activas y las que tengan existencia en lo mostrado
  const columnas = useMemo(() => {
    const usadas = new Set(filas.flatMap((x) => x.por_almacen.map((a) => a.almacen_id)));
    return almacenes.filter((a) => a.activo || usadas.has(a.id));
  }, [almacenes, filas]);
  const enAlmacen = (x: Fila, id: string) => x.por_almacen.find((a) => a.almacen_id === id);
  const almElegido = almacenes.find((a) => a.id === f.almacen_id);

  const exportar = async () => {
    try {
      const todas = await consulta(5000, 0);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet("Existencias");
      const cols = almElegido ? [] : columnas;
      ws.columns = [
        { header: "SKU", key: "sku", width: 16 }, { header: "Producto", key: "producto", width: 42 }, { header: "Marca", key: "marca", width: 16 },
        { header: "Categoría", key: "categoria", width: 16 }, { header: "Unidad base", key: "unidad", width: 10 },
        { header: almElegido ? `Existencia ${almElegido.nombre}` : "Existencia total", key: "total", width: 16 },
        { header: "Cajas + piezas", key: "cajas", width: 16 }, { header: "M²", key: "m2", width: 10 },
        { header: "Apartado", key: "apartado", width: 10 }, { header: "Disponible", key: "disponible", width: 12 },
        ...cols.map((a) => ({ header: a.nombre, key: a.id, width: 14 })),
      ];
      for (const x of todas) {
        const t = n(x.total);
        ws.addRow({
          sku: x.sku, producto: nombreConCaja(x.nombre, x.m2_por_caja, x.formato), marca: x.marca ?? "", categoria: x.categoria ?? "", unidad: x.unidad_base,
          total: t, cajas: x.presentacion === "piso" ? cantidadTxt(x, t) : "", m2: x.m2_por_caja && x.piezas_por_caja ? Math.round(t * n(x.m2_por_caja) / x.piezas_por_caja * 100) / 100 : "",
          apartado: n(x.apartado), disponible: t - n(x.apartado),
          ...Object.fromEntries(cols.map((a) => [a.id, n(enAlmacen(x, a.id)?.cantidad)])),
        });
      }
      ws.getRow(1).font = { bold: true };
      const b = new Blob([await wb.xlsx.writeBuffer()], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(b);
      Object.assign(document.createElement("a"), { href: url, download: `existencias-${new Date().toLocaleDateString("en-CA")}.xlsx` }).click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { setMsg(mensajeError(e)); }
  };

  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));
  const valorPagina = filas.reduce((s, x) => s + Math.max(n(x.total), 0) * n(x.costo), 0);

  const Celda = ({ x, cant }: { x: Fila; cant: number }) => (
    <td className={`pr-3 py-1.5 text-right whitespace-nowrap ${cant < 0 ? "text-[var(--peligro)] font-semibold" : cant === 0 ? "text-[var(--tenue)]" : ""}`}>
      {cant === 0 ? "—" : cantidadTxt(x, cant)}
      {cant !== 0 && m2Txt(x, cant) && <div className="text-xs text-[var(--tenue)] font-normal">{m2Txt(x, cant)}</div>}
    </td>
  );

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Almacenes y existencias</h1>
        <div className="flex gap-3 items-center text-sm">
          <Link href="/inventarios/hojas" className="underline">Hojas de cálculo</Link>
          <Link href="/configuracion/sucursales" className="underline">Administrar almacenes</Link>
          <button className="btn-primario" onClick={exportar}>Exportar a Excel</button>
        </div>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="SKU, nombre, formato o código de barras" value={f.texto} onChange={(e) => set("texto", e.target.value)} /></label>
        <label>Almacén
          <select className="campo" value={f.almacen_id} onChange={(e) => set("almacen_id", e.target.value)}>
            <option value="">Todos (vista general)</option>
            {almacenes.map((a) => <option key={a.id} value={a.id}>{a.sucursal ? `${a.sucursal} · ` : ""}{a.nombre}{a.activo ? "" : " (inactivo)"}</option>)}
          </select>
        </label>
        <label>Marca
          <select className="campo" value={f.marca_id} onChange={(e) => set("marca_id", e.target.value)}>
            <option value="">Todas</option>{marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}
          </select>
        </label>
        <label>Categoría
          <select className="campo" value={f.categoria_id} onChange={(e) => set("categoria_id", e.target.value)}>
            <option value="">Todas</option>{categorias.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
          </select>
        </label>
        <label>Mostrar
          <select className="campo" value={f.filtro} onChange={(e) => set("filtro", e.target.value)}>
            <option value="con">Con existencia</option><option value="">Todos los productos</option>
            <option value="sin">Sin existencia</option><option value="negativa">Existencia negativa</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: almElegido ? 900 : 700 + columnas.length * 130 }}>
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">SKU</th><th className="font-normal pr-3">Producto</th><th className="font-normal pr-3">Marca</th>
              {almElegido ? <>
                <th className="font-normal pr-3 text-right">Existencia</th><th className="font-normal pr-3 text-right">Apartado</th><th className="font-normal pr-3 text-right">Disponible</th>
              </> : <>
                <th className="font-normal pr-3 text-right">Total</th>
                {columnas.map((a) => <th key={a.id} className="font-normal pr-3 text-right whitespace-nowrap" title={a.sucursal}>{a.nombre}</th>)}
              </>}
            </tr>
          </thead>
          <tbody>
            {filas.map((x, i) => (
              <tr key={x.producto_id} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? undefined : "#f7f9fb", opacity: x.activo ? 1 : 0.6 }}>
                <td className="p-2 font-mono whitespace-nowrap">{x.sku}</td>
                <td className="py-1.5 pr-3">{nombreConCaja(x.nombre, x.m2_por_caja, x.formato)}{!x.activo && " (inactivo)"}
                  <div className="text-xs text-[var(--tenue)]">{x.categoria}</div></td>
                <td className="py-1.5 pr-3">{x.marca ?? "—"}</td>
                {almElegido ? <>
                  <Celda x={x} cant={n(x.total)} /><Celda x={x} cant={n(x.apartado)} /><Celda x={x} cant={n(x.total) - n(x.apartado)} />
                </> : <>
                  <Celda x={x} cant={n(x.total)} />
                  {columnas.map((a) => <Celda key={a.id} x={x} cant={n(enAlmacen(x, a.id)?.cantidad)} />)}
                </>}
              </tr>
            ))}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={5 + columnas.length} className="p-6 text-center text-[var(--tenue)]">No hay productos con esos filtros.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="flex justify-between items-center flex-wrap gap-3 text-sm">
        <span className="text-[var(--tenue)]">
          {cargando ? "Cargando…" : `${total} producto${total === 1 ? "" : "s"}`}
          {!cargando && valorPagina > 0 && <> · Valor a costo (esta página): ${fmtImporte(valorPagina)}</>}
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
