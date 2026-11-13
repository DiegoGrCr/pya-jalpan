"use client";
/** Compras > Productos: lista con búsqueda y filtros, alta, edición, plantilla e importación desde Excel. */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { generarPlantilla } from "@/lib/productos";
import { fmtCantidad } from "@/lib/unidades";

interface Fila {
  id: string; sku: string; nombre: string; formato: string | null; presentacion: "piso" | "unidad"; unidad_base: string;
  piezas_por_caja: number | null; m2_por_caja: string | null; precio_m2: string | null; activo: boolean;
  marcas: { nombre: string } | null; categorias: { nombre: string } | null;
  unidades_venta: { nombre: string; es_base: boolean; precios: { precio: string; lista_id: string }[] }[];
  existencias: { cantidad: string }[];
}

const POR_PAGINA = 50;
const mxn = (v: string | number) => `$${Number(v).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function Productos() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [lista, setLista] = useState<string | null>(null);
  const [marcas, setMarcas] = useState<string[]>([]);
  const [categorias, setCategorias] = useState<string[]>([]);
  const [texto, setTexto] = useState("");
  const [marca, setMarca] = useState("");
  const [categoria, setCategoria] = useState("");
  const [inactivos, setInactivos] = useState(false);
  const [pagina, setPagina] = useState(0);
  const [puedeEditar, setPuedeEditar] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    const g = new URLSearchParams(window.location.search).get("guardado");
    if (g) setMsg({ tipo: "ok", texto: `Producto ${g} guardado.` });
    (async () => {
      const sb = supabase();
      const [m, c, lp, perm] = await Promise.all([
        sb.from("marcas").select("nombre").order("nombre"), sb.from("categorias").select("nombre").order("nombre"),
        sb.from("listas_precios").select("id").eq("predeterminada", true).maybeSingle(),
        sb.rpc("tiene_permiso", { p_permiso: "editar_productos" }),
      ]);
      setMarcas(((m.data ?? []) as { nombre: string }[]).map((x) => x.nombre));
      setCategorias(((c.data ?? []) as { nombre: string }[]).map((x) => x.nombre));
      setLista(lp.data?.id ?? null);
      setPuedeEditar(perm.data === true);
    })();
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const sb = supabase();
      let q = sb.from("productos")
        .select("id, sku, nombre, formato, presentacion, unidad_base, piezas_por_caja, m2_por_caja, precio_m2, activo, marcas(nombre), categorias(nombre), unidades_venta(nombre, es_base, precios(precio, lista_id)), existencias(cantidad)", { count: "exact" })
        .order("nombre").range(pagina * POR_PAGINA, pagina * POR_PAGINA + POR_PAGINA - 1);
      if (!inactivos) q = q.eq("activo", true);
      const t = texto.trim().replace(/[%,()]/g, "");
      if (t) q = q.or(`nombre.ilike.%${t}%,sku.ilike.%${t}%,codigo_barras.eq.${t},formato.ilike.%${t}%`);
      if (marca) { const { data } = await sb.from("marcas").select("id").eq("nombre", marca).maybeSingle(); q = q.eq("marca_id", data?.id ?? "00000000-0000-0000-0000-000000000000"); }
      if (categoria) { const { data } = await sb.from("categorias").select("id").eq("nombre", categoria).maybeSingle(); q = q.eq("categoria_id", data?.id ?? "00000000-0000-0000-0000-000000000000"); }
      const { data, error, count } = await q;
      if (error) {
        if (/presentacion|formato/.test(error.message)) throw new Error("Falta ejecutar la migración 20261113000015_productos.sql en Supabase.");
        throw error;
      }
      setFilas((data ?? []) as unknown as Fila[]);
      setTotal(count ?? 0);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setCargando(false); }
  }, [texto, marca, categoria, inactivos, pagina]);

  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [texto, marca, categoria, inactivos]);

  const descargarPlantilla = async () => {
    try {
      const b = await generarPlantilla();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = "plantilla-productos.xlsx"; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  };

  const precio = (f: Fila, unidad: string) => f.unidades_venta.find((u) => u.nombre === unidad)?.precios.find((p) => p.lista_id === lista)?.precio;
  const filasVista = useMemo(() => filas.map((f) => {
    const ex = f.existencias.reduce((s, e) => s + Number(e.cantidad), 0);
    let existencia: string, precioTxt: string;
    if (f.presentacion === "piso" && f.piezas_por_caja) {
      const cajas = Math.trunc(ex / f.piezas_por_caja), sueltas = ex - cajas * f.piezas_por_caja;
      existencia = `${cajas} cj${sueltas ? ` + ${fmtCantidad(sueltas)} pz` : ""}`;
      const pc = precio(f, "CAJA");
      precioTxt = `${f.precio_m2 ? `${mxn(f.precio_m2)}/m²` : ""}${pc ? ` · ${mxn(pc)}/cj` : ""}`;
    } else {
      existencia = `${fmtCantidad(ex)} ${f.unidad_base}`;
      const pb = precio(f, f.unidad_base);
      precioTxt = pb ? `${mxn(pb)}/${f.unidad_base.toLowerCase()}` : "—";
    }
    return { f, existencia, precioTxt, negativa: ex < 0 };
  }), [filas, lista]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Productos</h1>
        <div className="flex gap-3 flex-wrap items-center text-sm">
          <button className="underline" onClick={descargarPlantilla}>Descargar plantilla de Excel</button>
          {puedeEditar && <Link href="/compras/productos/importar" className="underline">Importar desde Excel</Link>}
          {puedeEditar && <Link href="/compras/productos/nuevo" className="btn-primario">+ Nuevo producto</Link>}
        </div>
      </div>
      {msg && <div role="alert" className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_auto] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="Descripción, SKU, formato o código de barras" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Marca
          <select className="campo" value={marca} onChange={(e) => setMarca(e.target.value)}>
            <option value="">Todas</option>{marcas.map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label>Categoría
          <select className="campo" value={categoria} onChange={(e) => setCategoria(e.target.value)}>
            <option value="">Todas</option>{categorias.map((c) => <option key={c}>{c}</option>)}
          </select>
        </label>
        <label className="whitespace-nowrap pb-2"><input type="checkbox" checked={inactivos} onChange={(e) => setInactivos(e.target.checked)} /> Ver inactivos</label>
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[860px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left">
              <th className="p-2 font-normal">SKU</th><th className="font-normal">Descripción</th><th className="font-normal">Marca</th>
              <th className="font-normal">Formato</th><th className="font-normal">Caja</th><th className="font-normal">Precio</th>
              <th className="font-normal text-right pr-2">Existencia</th>
            </tr>
          </thead>
          <tbody>
            {filasVista.map(({ f, existencia, precioTxt, negativa }, i) => (
              <tr key={f.id} className="border-t border-[var(--borde)]" style={{ background: i % 2 ? "transparent" : "#f7f9fb", opacity: f.activo ? 1 : 0.5 }}>
                <td className="p-2 font-mono whitespace-nowrap">{puedeEditar ? <Link className="underline" href={`/compras/productos/${f.id}`}>{f.sku}</Link> : f.sku}</td>
                <td className="py-2">{f.nombre}{!f.activo && " (inactivo)"}<div className="text-xs text-[var(--tenue)]">{f.categorias?.nombre}</div></td>
                <td className="py-2">{f.marcas?.nombre ?? "—"}</td>
                <td className="py-2">{f.formato ?? "—"}</td>
                <td className="py-2 whitespace-nowrap">{f.presentacion === "piso" ? `${f.piezas_por_caja} pz · ${fmtCantidad(f.m2_por_caja ?? 0)} m²` : f.unidad_base}</td>
                <td className="py-2 whitespace-nowrap">{precioTxt}</td>
                <td className={`py-2 pr-2 text-right whitespace-nowrap ${negativa ? "text-[var(--peligro)] font-semibold" : ""}`}>{existencia}</td>
              </tr>
            ))}
            {!cargando && filas.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-[var(--tenue)]">
                No hay productos{texto || marca || categoria ? " con esos filtros" : ""}. {puedeEditar && <>Da de alta uno con <b>+ Nuevo producto</b> o súbelos con <b>Importar desde Excel</b>.</>}
              </td></tr>
            )}
          </tbody>
        </table>
      </section>
      <div className="flex justify-between items-center text-sm">
        <span className="text-[var(--tenue)]">{cargando ? "Cargando…" : `${total} producto${total === 1 ? "" : "s"}`}</span>
        {total > POR_PAGINA && (
          <div className="flex gap-3">
            <button className="underline disabled:opacity-40" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>← Anterior</button>
            <span>Página {pagina + 1} de {Math.ceil(total / POR_PAGINA)}</span>
            <button className="underline disabled:opacity-40" disabled={(pagina + 1) * POR_PAGINA >= total} onClick={() => setPagina((p) => p + 1)}>Siguiente →</button>
          </div>
        )}
      </div>
    </div>
  );
}
