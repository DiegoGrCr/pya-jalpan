"use client";
/**
 * Inventarios › Ajustes y conteo:
 *  - Ajuste: entrada (+) o salida (−) de material con motivo (merma, rotura, regalo, corrección…). registrar_ajuste.
 *  - Conteo físico: se captura lo contado; al guardar se compara contra la existencia de ese momento y se ajusta solo
 *    la diferencia (registrar_conteo, 0057). Opción «a ciegas» para no ver lo que dice el sistema mientras se cuenta.
 *  - Lista de ajustes con su detalle.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { nombreConCaja } from "@/lib/unidades";
import { fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { EsqueletoFilas } from "@/components/Esqueleto";
import ProductoBuscador, { ProductoSimple, UnidadSimple, cajaPieza, textoBase } from "@/components/ProductoBuscador";
import { useSoloConsulta } from "@/lib/rol";

interface Almacen { id: string; nombre: string; sucursales: { codigo: string } | null }
interface Ajuste {
  id: string; serie: string; folio: number; fecha: string; motivo: string; origen: string; usuario_id: string | null; almacen_id: string;
  ajuste_partidas: { id: string; cantidad_base: string; productos: { sku: string; nombre: string; unidad_base: string; m2_por_caja: string | null; formato: string | null } | null }[];
}
interface Linea { uid: string; p: ProductoSimple; signo: 1 | -1; cajas: string; piezas: string; unidadId: string; cantidad: string }
const MOTIVOS = ["Merma o rotura", "Material dañado", "Corrección de captura", "Material encontrado", "Uso interno / muestra", "Regalo o cortesía", "Otro"];
const ORIGEN: Record<string, string> = { manual: "Ajuste", conteo: "Conteo físico", inventario_inicial: "Inventario inicial", hoja_calculo: "Hoja de cálculo" };
const baseDe = (p: ProductoSimple, cajas: string, piezas: string, unidadId: string, cantidad: string) => {
  const cp = cajaPieza(p);
  if (cp) return (Number(cajas) || 0) * cp.caja.factor + (Number(piezas) || 0) * cp.pieza.factor;
  return (Number(cantidad) || 0) * (p.unidades.find((u) => u.id === unidadId)?.factor ?? 1);
};

export default function AjustesConteo() {
  const solo = useSoloConsulta();
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [filas, setFilas] = useState<Ajuste[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [modo, setModo] = useState<"lista" | "ajuste" | "conteo">("lista");
  // Ajuste
  const [aj, setAj] = useState<{ clave: string; almacen: string; motivo: string; detalle: string; lineas: Linea[] }>({ clave: crypto.randomUUID(), almacen: "", motivo: "", detalle: "", lineas: [] });
  // Conteo
  const [marcas, setMarcas] = useState<{ id: string; nombre: string }[]>([]);
  const [categorias, setCategorias] = useState<{ id: string; nombre: string }[]>([]);
  const [ct, setCt] = useState<{ clave: string; almacen: string; marca: string; categoria: string; texto: string; ciegas: boolean }>({ clave: crypto.randomUUID(), almacen: "", marca: "", categoria: "", texto: "", ciegas: false });
  const [productosConteo, setProductosConteo] = useState<(ProductoSimple & { existencia: number })[] | null>(null);
  const [contado, setContado] = useState<Record<string, { cajas: string; piezas: string; cantidad: string }>>({});

  useEffect(() => {
    const sb = supabase();
    sb.from("almacenes").select("id, nombre, sucursales(codigo)").eq("activo", true).order("nombre").then(({ data }: { data: unknown }) => setAlmacenes((data ?? []) as Almacen[]));
    sb.from("marcas").select("id, nombre").order("nombre").then(({ data }: { data: unknown }) => setMarcas((data ?? []) as { id: string; nombre: string }[]));
    sb.from("categorias").select("id, nombre").order("nombre").then(({ data }: { data: unknown }) => setCategorias((data ?? []) as { id: string; nombre: string }[]));
  }, []);
  const nomAlm = useCallback((id: string) => { const a = almacenes.find((x) => x.id === id); return a ? `${a.sucursales?.codigo ? `${a.sucursales.codigo} · ` : ""}${a.nombre}` : "—"; }, [almacenes]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const { data, error } = await supabase().from("ajustes").select("id, serie, folio, fecha, motivo, origen, usuario_id, almacen_id, ajuste_partidas(id, cantidad_base, productos(sku, nombre, unidad_base, m2_por_caja, formato))")
        .order("fecha", { ascending: false }).limit(300);
      if (error) throw error;
      const f = (data ?? []) as unknown as Ajuste[];
      setFilas(f);
      const ids = f.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const guardarAjuste = async () => {
    const motivo = [aj.motivo, aj.detalle.trim()].filter(Boolean).join(": ");
    const partidas = aj.lineas.map((l) => ({ producto_id: l.p.id, unidad_venta_id: l.p.unidades.find((u) => u.es_base)?.id,
      cantidad: Math.round(l.signo * baseDe(l.p, l.cajas, l.piezas, l.unidadId, l.cantidad) * 1e6) / 1e6 })).filter((x) => x.cantidad !== 0);
    setTrabajando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("registrar_ajuste", { p: { idempotency_key: aj.clave, almacen_id: aj.almacen, motivo, origen: "manual", partidas } });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `Ajuste ${data.serie} ${data.folio} registrado.` });
      setAj({ clave: crypto.randomUUID(), almacen: aj.almacen, motivo: "", detalle: "", lineas: [] }); setModo("lista"); await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); setAj((x) => ({ ...x, clave: crypto.randomUUID() })); } finally { setTrabajando(false); }
  };

  const cargarConteo = async () => {
    if (!ct.almacen) return;
    setTrabajando(true); setMsg(null);
    try {
      const sb = supabase();
      const consulta = (extra: string) => {
        let q = sb.from("productos").select(`id, sku, nombre, unidad_base, permite_fraccion, tipo${extra}, unidades_venta(id, nombre, factor, es_base, orden)`)
          .eq("activo", true).eq("tipo", "producto").order("sku").limit(1000);
        if (ct.marca) q = q.eq("marca_id", ct.marca);
        if (ct.categoria) q = q.eq("categoria_id", ct.categoria);
        const t = ct.texto.trim().replace(/[%,()]/g, "");
        if (t) q = q.or(`sku.ilike.%${t}%,nombre.ilike.%${t}%`);
        return q;
      };
      let { data, error } = await consulta(", m2_por_caja, piezas_por_caja, formato");
      if (error) ({ data, error } = await consulta(""));
      if (error) throw error;
      const prods = ((data ?? []) as unknown as (Omit<ProductoSimple, "unidades"> & { unidades_venta: UnidadSimple[] })[]).map(({ unidades_venta, ...p }) => ({
        ...p, m2_por_caja: p.m2_por_caja ?? null, piezas_por_caja: p.piezas_por_caja ?? null, formato: p.formato ?? null,
        unidades: unidades_venta.map((u) => ({ ...u, factor: Number(u.factor) })).sort((a, b) => a.orden - b.orden) }));
      const ex = new Map<string, number>();
      for (let i = 0; i < prods.length; i += 200) {
        const { data: e } = await sb.from("existencias").select("producto_id, cantidad").eq("almacen_id", ct.almacen).in("producto_id", prods.slice(i, i + 200).map((p) => p.id));
        for (const x of (e ?? []) as { producto_id: string; cantidad: string }[]) ex.set(x.producto_id, Number(x.cantidad));
      }
      setProductosConteo(prods.map((p) => ({ ...p, existencia: ex.get(p.id) ?? 0 })));
      setContado({});
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const capturados = useMemo(() => (productosConteo ?? []).filter((p) => {
    const c = contado[p.id]; return c && (c.cajas !== "" || c.piezas !== "" || c.cantidad !== "");
  }), [productosConteo, contado]);

  const guardarConteo = async () => {
    const base = (p: ProductoSimple) => { const c = contado[p.id]; return baseDe(p, c.cajas, c.piezas, p.unidades.find((u) => u.es_base)?.id ?? "", c.cantidad); };
    setTrabajando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("registrar_conteo", { p: { idempotency_key: ct.clave, almacen_id: ct.almacen, motivo: `Conteo físico de ${nomAlm(ct.almacen)}`,
        partidas: capturados.map((p) => ({ producto_id: p.id, contado_base: Math.round(base(p) * 1e6) / 1e6 })) } });
      if (error) {
        if (/registrar_conteo/.test(error.message)) throw new Error("Falta ejecutar la migración 20261123000057_conteo_fisico.sql en Supabase.");
        throw error;
      }
      const d = data as { sin_diferencias: boolean; serie?: string; folio?: number; detalle: { diferencia: number }[] };
      const dif = d.detalle.filter((x) => Number(x.diferencia) !== 0).length;
      setMsg({ tipo: "ok", texto: d.sin_diferencias ? `Conteo de ${capturados.length} productos sin diferencias: no hubo que ajustar nada.`
        : `Conteo guardado: ${dif} de ${capturados.length} productos tenían diferencia y se ajustaron (ajuste ${d.serie} ${d.folio}).` });
      setCt((x) => ({ ...x, clave: crypto.randomUUID() })); setProductosConteo(null); setContado({}); setModo("lista"); await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); setCt((x) => ({ ...x, clave: crypto.randomUUID() })); } finally { setTrabajando(false); }
  };

  const entrada = (u: string, val: string, onChange: (v: string) => void, ancho = "w-20") =>
    <label className={`text-xs ${ancho}`}>{u}<input className="campo !py-1 text-right" inputMode="decimal" value={val} onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} /></label>;

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Ajustes y conteo físico</h1>
        {!solo && <div className="flex gap-2">
          <button className={modo === "conteo" ? "btn-primario" : "px-3 py-2 rounded border border-[var(--acento)] text-[var(--acento)] text-sm"} onClick={() => setModo(modo === "conteo" ? "lista" : "conteo")}>Conteo físico</button>
          <button className={modo === "ajuste" ? "btn-primario" : "px-3 py-2 rounded border border-[var(--acento)] text-[var(--acento)] text-sm"} onClick={() => setModo(modo === "ajuste" ? "lista" : "ajuste")}>+ Ajuste</button>
        </div>}
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      {modo === "ajuste" && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--acento)] p-4 flex flex-col gap-3 text-sm">
          <div className="barra-seccion">Nuevo ajuste</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>Almacén<select className="campo" value={aj.almacen} onChange={(e) => setAj({ ...aj, almacen: e.target.value })}>
              <option value="">— Elige —</option>{almacenes.map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}</select></label>
            <label>Motivo<select className="campo" value={aj.motivo} onChange={(e) => setAj({ ...aj, motivo: e.target.value })}>
              <option value="">— Elige —</option>{MOTIVOS.map((m) => <option key={m}>{m}</option>)}</select></label>
            <label>Detalle {aj.motivo === "Otro" ? "*" : "(opcional)"}<input className="campo" value={aj.detalle} onChange={(e) => setAj({ ...aj, detalle: e.target.value })} /></label>
          </div>
          <ProductoBuscador onElegir={(p) => setAj((x) => (x.lineas.some((l) => l.p.id === p.id) ? x
            : { ...x, lineas: [...x.lineas, { uid: crypto.randomUUID(), p, signo: -1, cajas: "", piezas: "", unidadId: (p.unidades.find((u) => !u.es_base) ?? p.unidades[0]).id, cantidad: "" }] }))} />
          {aj.lineas.length > 0 && (
            <table className="w-full">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]"><th className="py-1 font-normal">Producto</th><th className="font-normal">Movimiento</th><th className="font-normal">Cantidad</th><th /></tr></thead>
              <tbody>
                {aj.lineas.map((l) => {
                  const cp = cajaPieza(l.p);
                  const set = (c: Partial<Linea>) => setAj((x) => ({ ...x, lineas: x.lineas.map((y) => (y.uid === l.uid ? { ...y, ...c } : y)) }));
                  return (
                    <tr key={l.uid} className="border-b border-[var(--borde)] align-top">
                      <td className="py-2">{l.p.sku} - {nombreConCaja(l.p.nombre, l.p.m2_por_caja, l.p.formato)}</td>
                      <td className="py-1"><select className={`campo !py-1 !w-auto ${l.signo < 0 ? "text-[var(--peligro)]" : "text-emerald-700"}`} value={l.signo} onChange={(e) => set({ signo: Number(e.target.value) as 1 | -1 })}>
                        <option value={-1}>Sale (−)</option><option value={1}>Entra (+)</option></select></td>
                      <td className="py-1"><div className="flex gap-1">{cp ? <>{entrada("Cajas", l.cajas, (v) => set({ cajas: v }))}{entrada("Piezas", l.piezas, (v) => set({ piezas: v }))}</> : <>
                        {entrada("Cantidad", l.cantidad, (v) => set({ cantidad: v }), "w-24")}
                        <label className="text-xs">Unidad<select className="campo !py-1 !w-auto" value={l.unidadId} onChange={(e) => set({ unidadId: e.target.value })}>
                          {l.p.unidades.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}</select></label></>}</div></td>
                      <td className="py-2 text-right"><button className="text-[var(--peligro)]" aria-label="Quitar" onClick={() => setAj((x) => ({ ...x, lineas: x.lineas.filter((y) => y.uid !== l.uid) }))}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="flex justify-end gap-3">
            <button className="underline" onClick={() => setModo("lista")}>Cancelar</button>
            <button className="btn-primario" disabled={trabajando || !aj.almacen || !aj.motivo || (aj.motivo === "Otro" && !aj.detalle.trim())
              || !aj.lineas.some((l) => baseDe(l.p, l.cajas, l.piezas, l.unidadId, l.cantidad) > 0)} onClick={guardarAjuste}>{trabajando ? "Guardando…" : "Registrar ajuste"}</button>
          </div>
        </section>
      )}

      {modo === "conteo" && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--acento)] p-4 flex flex-col gap-3 text-sm">
          <div className="barra-seccion">Conteo físico</div>
          <p className="text-[var(--tenue)]">Elige el almacén y qué vas a contar (por marca, categoría o búsqueda). Captura solo lo que contaste; al guardar,
            el sistema compara con su existencia de ese momento y ajusta únicamente las diferencias.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 items-end">
            <label>Almacén<select className="campo" value={ct.almacen} onChange={(e) => { setCt({ ...ct, almacen: e.target.value }); setProductosConteo(null); }}>
              <option value="">— Elige —</option>{almacenes.map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}</select></label>
            <label>Marca<select className="campo" value={ct.marca} onChange={(e) => setCt({ ...ct, marca: e.target.value })}>
              <option value="">Todas</option>{marcas.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></label>
            <label>Categoría<select className="campo" value={ct.categoria} onChange={(e) => setCt({ ...ct, categoria: e.target.value })}>
              <option value="">Todas</option>{categorias.map((m) => <option key={m.id} value={m.id}>{m.nombre}</option>)}</select></label>
            <label>Buscar<input className="campo" placeholder="Código o nombre" value={ct.texto} onChange={(e) => setCt({ ...ct, texto: e.target.value })} /></label>
            <button className="btn-primario" disabled={!ct.almacen || trabajando} onClick={cargarConteo}>Cargar productos</button>
          </div>
          <label className="flex items-center gap-2"><input type="checkbox" checked={ct.ciegas} onChange={(e) => setCt({ ...ct, ciegas: e.target.checked })} />
            Conteo a ciegas (no mostrar lo que dice el sistema mientras se cuenta)</label>
          {productosConteo && (
            <div className="overflow-x-auto max-h-[60vh] overflow-y-auto border border-[var(--borde)] rounded">
              <table className="w-full">
                <thead className="sticky top-0 bg-[var(--panel)]" style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                  <th className="p-2 font-normal">Producto</th>{!ct.ciegas && <th className="font-normal text-right pr-3">Sistema</th>}<th className="font-normal">Contado</th>
                  {!ct.ciegas && <th className="font-normal text-right pr-2">Diferencia</th>}</tr></thead>
                <tbody>
                  {productosConteo.map((p) => {
                    const cp = cajaPieza(p); const c = contado[p.id] ?? { cajas: "", piezas: "", cantidad: "" };
                    const set = (k: "cajas" | "piezas" | "cantidad", v: string) => setContado((m) => ({ ...m, [p.id]: { ...c, [k]: v } }));
                    const lleno = c.cajas !== "" || c.piezas !== "" || c.cantidad !== "";
                    const dif = lleno ? baseDe(p, c.cajas, c.piezas, p.unidades.find((u) => u.es_base)?.id ?? "", c.cantidad) - p.existencia : 0;
                    return (
                      <tr key={p.id} className="border-b border-[var(--borde)]">
                        <td className="p-2">{p.sku} - {nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}</td>
                        {!ct.ciegas && <td className="pr-3 text-right whitespace-nowrap">{textoBase(p, p.existencia)}</td>}
                        <td className="py-1"><div className="flex gap-1">{cp ? <>{entrada("Cajas", c.cajas, (v) => set("cajas", v))}{entrada("Piezas", c.piezas, (v) => set("piezas", v))}</>
                          : entrada(p.unidad_base, c.cantidad, (v) => set("cantidad", v), "w-24")}</div></td>
                        {!ct.ciegas && <td className={`pr-2 text-right whitespace-nowrap ${!lleno ? "" : Math.abs(dif) < 1e-6 ? "text-emerald-700" : "text-[var(--peligro)] font-semibold"}`}>
                          {!lleno ? "" : Math.abs(dif) < 1e-6 ? "✓" : `${dif > 0 ? "+" : ""}${textoBase(p, dif)}`}</td>}
                      </tr>
                    );
                  })}
                  {!productosConteo.length && <tr><td colSpan={4} className="p-4 text-center text-[var(--tenue)]">No hay productos con esos filtros.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
          {productosConteo && <div className="flex justify-between items-center gap-3 flex-wrap">
            <span className="text-[var(--tenue)]">{capturados.length} de {productosConteo.length} productos capturados. Los que dejes vacíos no se tocan.</span>
            <div className="flex gap-3"><button className="underline" onClick={() => setModo("lista")}>Cancelar</button>
              <button className="btn-primario" disabled={trabajando || !capturados.length} onClick={guardarConteo}>{trabajando ? "Guardando…" : "Guardar conteo"}</button></div>
          </div>}
        </section>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">#</th><th className="font-normal">Fecha</th><th className="font-normal">Almacén</th><th className="font-normal">Tipo</th>
            <th className="font-normal">Motivo</th><th className="font-normal">Productos</th><th className="font-normal">Registró</th></tr></thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={7} />}
            {filas.map((a) => (
              <Fragment key={a.id}>
                <tr className="border-b border-[var(--borde)] align-top">
                  <td className="p-2 whitespace-nowrap"><button className="underline" onClick={() => setAbierto(abierto === a.id ? null : a.id)}>{a.serie} {a.folio}</button></td>
                  <td className="py-2 whitespace-nowrap">{fechaMx(a.fecha)}</td><td className="py-2">{nomAlm(a.almacen_id)}</td>
                  <td className="py-2">{ORIGEN[a.origen] ?? a.origen}</td><td className="py-2">{a.motivo}</td>
                  <td className="py-2">{a.ajuste_partidas.length}</td><td className="py-2">{a.usuario_id ? nombres[a.usuario_id] ?? "" : ""}</td>
                </tr>
                {abierto === a.id && <tr className="border-b border-[var(--borde)] bg-[var(--resalte)]/40"><td colSpan={7} className="px-8 py-2 text-xs">
                  {a.ajuste_partidas.map((p) => {
                    const n = Number(p.cantidad_base);
                    return <div key={p.id} className="flex justify-between gap-4 py-0.5"><span>{p.productos?.sku} - {nombreConCaja(p.productos?.nombre ?? "", p.productos?.m2_por_caja ?? null, p.productos?.formato ?? null)}</span>
                      <span className={n < 0 ? "text-[var(--peligro)]" : "text-emerald-700"}>{n > 0 ? "+" : "−"}{Math.round(Math.abs(n) * 1000) / 1000} {p.productos?.unidad_base}</span></div>;
                  })}
                </td></tr>}
              </Fragment>
            ))}
            {!cargando && !filas.length && <tr><td colSpan={7} className="p-6 text-center text-[var(--tenue)]">No hay ajustes registrados.</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  );
}
