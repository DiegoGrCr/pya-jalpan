"use client";
/**
 * Inventarios › Traspasos: mover material entre almacenes/sucursales.
 * Enviar (sale del origen) → en tránsito (opcional) → recibir en el destino (completo o con diferencias), o cancelar
 * mientras no se reciba (regresa al origen). Usa enviar_traspaso, marcar_traspaso_en_transito, recibir_traspaso y cancelar_traspaso.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, nombreConCaja } from "@/lib/unidades";
import { fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { EsqueletoFilas } from "@/components/Esqueleto";
import ProductoBuscador, { ProductoSimple, cajaPieza } from "@/components/ProductoBuscador";
import { useSoloConsulta } from "@/lib/rol";

interface Almacen { id: string; nombre: string; sucursal_id: string; sucursales: { codigo: string } | null }
interface Traspaso {
  id: string; serie: string; folio: number; estado: "enviado" | "en_transito" | "recibido" | "cancelado"; enviado_en: string; recibido_en: string | null;
  almacen_origen: string; almacen_destino: string; enviado_por: string | null; recibido_por: string | null; comentarios: string | null;
  traspaso_partidas: { id: string; cantidad: string; factor: string; cantidad_base: string; cantidad_recibida_base: string | null;
    unidades_venta: { nombre: string } | null; productos: { sku: string; nombre: string; unidad_base: string; m2_por_caja: string | null; formato: string | null } | null }[];
}
interface Linea { uid: string; p: ProductoSimple; cajas: string; piezas: string; unidadId: string; cantidad: string }
const ESTADOS: Record<Traspaso["estado"], { t: string; cls: string }> = {
  enviado: { t: "Enviado", cls: "bg-sky-100 text-sky-900" }, en_transito: { t: "En tránsito", cls: "bg-amber-100 text-amber-900" },
  recibido: { t: "Recibido", cls: "bg-emerald-100 text-emerald-900" }, cancelado: { t: "Cancelado", cls: "bg-gray-200 text-gray-700" },
};
const baseDe = (l: Linea) => {
  const cp = cajaPieza(l.p);
  if (cp) return (Number(l.cajas) || 0) * cp.caja.factor + (Number(l.piezas) || 0) * cp.pieza.factor;
  const u = l.p.unidades.find((x) => x.id === l.unidadId);
  return (Number(l.cantidad) || 0) * (u?.factor ?? 1);
};

export default function Traspasos() {
  const solo = useSoloConsulta();
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [filas, setFilas] = useState<Traspaso[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [estado, setEstado] = useState<"" | "pendientes" | Traspaso["estado"]>("pendientes");
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [nuevo, setNuevo] = useState<{ clave: string; origen: string; destino: string; comentarios: string; lineas: Linea[] } | null>(null);
  const [existOrigen, setExistOrigen] = useState<Record<string, number>>({});
  const [recibir, setRecibir] = useState<{ t: Traspaso; cant: Record<string, string> } | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  useEffect(() => {
    supabase().from("almacenes").select("id, nombre, sucursal_id, sucursales(codigo)").eq("activo", true).order("nombre")
      .then(({ data }: { data: unknown }) => setAlmacenes((data ?? []) as Almacen[]));
  }, []);
  const nomAlm = useCallback((id: string) => { const a = almacenes.find((x) => x.id === id); return a ? `${a.sucursales?.codigo ? `${a.sucursales.codigo} · ` : ""}${a.nombre}` : "—"; }, [almacenes]);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      let q = supabase().from("traspasos").select(`id, serie, folio, estado, enviado_en, recibido_en, almacen_origen, almacen_destino, enviado_por, recibido_por, comentarios,
        traspaso_partidas(id, cantidad, factor, cantidad_base, cantidad_recibida_base, unidades_venta(nombre), productos(sku, nombre, unidad_base, m2_por_caja, formato))`)
        .order("enviado_en", { ascending: false }).limit(300);
      if (estado === "pendientes") q = q.in("estado", ["enviado", "en_transito"]);
      else if (estado) q = q.eq("estado", estado);
      const { data, error } = await q;
      if (error) throw error;
      const f = (data ?? []) as unknown as Traspaso[];
      setFilas(f);
      const ids = f.flatMap((x) => [x.enviado_por, x.recibido_por]).filter((x): x is string => !!x);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [estado]);
  useEffect(() => { cargar(); }, [cargar]);

  // Existencia en el almacén de origen de los productos del traspaso nuevo
  const idsNuevo = useMemo(() => (nuevo?.lineas ?? []).map((l) => l.p.id).join(","), [nuevo?.lineas]);
  useEffect(() => {
    if (!nuevo?.origen || !idsNuevo) return;
    supabase().from("existencias").select("producto_id, cantidad, apartado").eq("almacen_id", nuevo.origen).in("producto_id", idsNuevo.split(","))
      .then(({ data }: { data: unknown }) => setExistOrigen(Object.fromEntries(((data ?? []) as { producto_id: string; cantidad: string; apartado: string }[])
        .map((e) => [e.producto_id, Number(e.cantidad) - Number(e.apartado)]))));
  }, [nuevo?.origen, idsNuevo]);

  const ejecutar = async (fn: () => Promise<{ error: { message: string } | null }>, ok: string) => {
    setTrabajando(true); setMsg(null);
    try { const { error } = await fn(); if (error) throw error; setMsg({ tipo: "ok", texto: ok }); await cargar(); return true; }
    catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); return false; } finally { setTrabajando(false); }
  };

  const enviar = async () => {
    if (!nuevo) return;
    const partidas = nuevo.lineas.map((l) => ({ producto_id: l.p.id, unidad_venta_id: l.p.unidades.find((u) => u.es_base)?.id, cantidad: Math.round(baseDe(l) * 1e6) / 1e6 }))
      .filter((x) => x.cantidad > 0);
    if (!partidas.length) { setMsg({ tipo: "error", texto: "Captura cuánto se envía de cada producto." }); return; }
    if (await ejecutar(() => supabase().rpc("enviar_traspaso", { p: { idempotency_key: nuevo.clave, almacen_origen: nuevo.origen, almacen_destino: nuevo.destino,
      comentarios: nuevo.comentarios || null, partidas } }), "Traspaso enviado: el material ya salió del almacén de origen.")) setNuevo(null);
  };

  const guardarRecepcion = async () => {
    if (!recibir) return;
    const partidas = recibir.t.traspaso_partidas.map((p) => ({ partida_id: p.id,
      cantidad_recibida_base: recibir.cant[p.id] === undefined || recibir.cant[p.id] === "" ? Number(p.cantidad_base) : Math.round(Number(recibir.cant[p.id]) * Number(p.factor) * 1e6) / 1e6 }));
    if (await ejecutar(() => supabase().rpc("recibir_traspaso", { p: { traspaso_id: recibir.t.id, partidas } }), `Traspaso ${recibir.t.serie} ${recibir.t.folio} recibido.`)) setRecibir(null);
  };

  const cancelar = (t: Traspaso) => {
    const motivo = window.prompt(`Motivo para cancelar el traspaso ${t.serie} ${t.folio} (el material regresa al origen):`);
    if (!motivo?.trim()) return;
    ejecutar(() => supabase().rpc("cancelar_traspaso", { p_traspaso: t.id, p_motivo: motivo.trim() }), "Traspaso cancelado: el material regresó al almacén de origen.");
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Traspasos</h1>
        {!solo && !nuevo && <button className="btn-primario" onClick={() => setNuevo({ clave: crypto.randomUUID(), origen: "", destino: "", comentarios: "", lineas: [] })}>+ Nuevo traspaso</button>}
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      {nuevo && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--acento)] p-4 flex flex-col gap-3 text-sm">
          <div className="barra-seccion">Nuevo traspaso</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <label>Sale de (origen)
              <select className="campo" value={nuevo.origen} onChange={(e) => setNuevo({ ...nuevo, origen: e.target.value })}>
                <option value="">— Elige —</option>{almacenes.map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}
              </select>
            </label>
            <label>Llega a (destino)
              <select className="campo" value={nuevo.destino} onChange={(e) => setNuevo({ ...nuevo, destino: e.target.value })}>
                <option value="">— Elige —</option>{almacenes.filter((a) => a.id !== nuevo.origen).map((a) => <option key={a.id} value={a.id}>{nomAlm(a.id)}</option>)}
              </select>
            </label>
            <label>Comentarios<input className="campo" placeholder="Opcional (p. ej. quién lo lleva)" value={nuevo.comentarios} onChange={(e) => setNuevo({ ...nuevo, comentarios: e.target.value })} /></label>
          </div>
          <ProductoBuscador onElegir={(p) => setNuevo((n) => n && (n.lineas.some((l) => l.p.id === p.id) ? n
            : { ...n, lineas: [...n.lineas, { uid: crypto.randomUUID(), p, cajas: "", piezas: "", unidadId: (p.unidades.find((u) => !u.es_base) ?? p.unidades[0]).id, cantidad: "" }] }))} />
          {nuevo.lineas.length > 0 && (
            <table className="w-full">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="py-1 font-normal">Producto</th><th className="font-normal text-right pr-3">Disponible en origen</th><th className="font-normal">Envía</th><th /></tr></thead>
              <tbody>
                {nuevo.lineas.map((l) => {
                  const cp = cajaPieza(l.p);
                  const set = (c: Partial<Linea>) => setNuevo((n) => n && { ...n, lineas: n.lineas.map((x) => (x.uid === l.uid ? { ...x, ...c } : x)) });
                  const disp = existOrigen[l.p.id];
                  return (
                    <tr key={l.uid} className="border-b border-[var(--borde)] align-top">
                      <td className="py-2">{l.p.sku} - {nombreConCaja(l.p.nombre, l.p.m2_por_caja, l.p.formato)}</td>
                      <td className={`py-2 pr-3 text-right ${disp !== undefined && baseDe(l) > disp + 1e-6 ? "text-[var(--peligro)] font-semibold" : ""}`}>
                        {nuevo.origen ? (disp === undefined ? "0" : `${fmtCantidad(disp)} ${l.p.unidad_base}`) : "—"}</td>
                      <td className="py-1">{cp ? (
                        <div className="flex gap-1">
                          <label className="text-xs w-20">Cajas<input className="campo !py-1 text-right" inputMode="numeric" value={l.cajas} onChange={(e) => set({ cajas: e.target.value.replace(/\D/g, "") })} /></label>
                          <label className="text-xs w-20">Piezas<input className="campo !py-1 text-right" inputMode="numeric" value={l.piezas} onChange={(e) => set({ piezas: e.target.value.replace(/\D/g, "") })} /></label>
                        </div>
                      ) : (
                        <div className="flex gap-1">
                          <input className="campo !py-1 text-right w-24" inputMode="decimal" value={l.cantidad} onChange={(e) => set({ cantidad: e.target.value })} />
                          <select className="campo !py-1 !w-auto" value={l.unidadId} onChange={(e) => set({ unidadId: e.target.value })}>
                            {l.p.unidades.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}</select>
                        </div>
                      )}</td>
                      <td className="py-2 text-right"><button className="text-[var(--peligro)]" aria-label="Quitar" onClick={() => setNuevo((n) => n && { ...n, lineas: n.lineas.filter((x) => x.uid !== l.uid) })}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <div className="flex justify-end gap-3">
            <button className="underline" onClick={() => setNuevo(null)}>Cancelar</button>
            <button className="btn-primario" disabled={trabajando || !nuevo.origen || !nuevo.destino || !nuevo.lineas.some((l) => baseDe(l) > 0)} onClick={enviar}>
              {trabajando ? "Enviando…" : "Enviar traspaso"}</button>
          </div>
        </section>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
        <label>Mostrar
          <select className="campo" value={estado} onChange={(e) => setEstado(e.target.value as typeof estado)}>
            <option value="pendientes">Pendientes de recibir</option><option value="recibido">Recibidos</option><option value="cancelado">Cancelados</option><option value="">Todos</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[820px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">#</th><th className="font-normal">Enviado</th><th className="font-normal">De</th><th className="font-normal">A</th>
            <th className="font-normal">Productos</th><th className="font-normal">Estado</th><th className="pr-2" /></tr></thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={7} />}
            {filas.map((t) => {
              const abiertoT = t.estado === "enviado" || t.estado === "en_transito";
              return (
                <Fragment key={t.id}>
                  <tr className="border-b border-[var(--borde)] align-top">
                    <td className="p-2 whitespace-nowrap"><button className="underline" onClick={() => setAbierto(abierto === t.id ? null : t.id)}>{t.serie} {t.folio}</button></td>
                    <td className="py-2 whitespace-nowrap">{fechaMx(t.enviado_en)}<div className="text-xs text-[var(--tenue)]">{t.enviado_por ? nombres[t.enviado_por] ?? "" : ""}</div></td>
                    <td className="py-2">{nomAlm(t.almacen_origen)}</td><td className="py-2">{nomAlm(t.almacen_destino)}</td>
                    <td className="py-2">{t.traspaso_partidas.length} producto{t.traspaso_partidas.length === 1 ? "" : "s"}</td>
                    <td className="py-2"><span className={`px-1.5 rounded text-xs ${ESTADOS[t.estado].cls}`}>{ESTADOS[t.estado].t}</span>
                      {t.recibido_en && <div className="text-xs text-[var(--tenue)]">{fechaMx(t.recibido_en)}</div>}</td>
                    <td className="pr-2 py-1.5 text-right whitespace-nowrap">
                      {abiertoT && !solo && <span className="inline-flex gap-1 text-xs">
                        {t.estado === "enviado" && <button className="px-2 h-7 rounded border border-amber-600 text-amber-800" disabled={trabajando}
                          onClick={() => ejecutar(() => supabase().rpc("marcar_traspaso_en_transito", { p_traspaso: t.id }), "Marcado en tránsito.")}>En tránsito</button>}
                        <button className="px-2 h-7 rounded border border-emerald-600 text-emerald-700" onClick={() => setRecibir({ t, cant: {} })}>Recibir</button>
                        <button className="px-2 h-7 rounded border border-[var(--peligro)] text-[var(--peligro)]" disabled={trabajando} onClick={() => cancelar(t)}>Cancelar</button>
                      </span>}
                    </td>
                  </tr>
                  {abierto === t.id && (
                    <tr className="border-b border-[var(--borde)] bg-[var(--resalte)]/40"><td colSpan={7} className="px-8 py-2 text-xs">
                      {t.traspaso_partidas.map((p) => (
                        <div key={p.id} className="flex justify-between gap-4 py-0.5">
                          <span>{p.productos?.sku} - {nombreConCaja(p.productos?.nombre ?? "", p.productos?.m2_por_caja ?? null, p.productos?.formato ?? null)}</span>
                          <span>{fmtCantidad(p.cantidad)} {p.unidades_venta?.nombre}
                            {p.cantidad_recibida_base != null && Number(p.cantidad_recibida_base) !== Number(p.cantidad_base) &&
                              <b className="text-[var(--peligro)]"> · recibido {fmtCantidad(Number(p.cantidad_recibida_base) / Number(p.factor))}</b>}</span>
                        </div>
                      ))}
                      {t.comentarios && <div className="mt-1 text-[var(--tenue)]">{t.comentarios}</div>}
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            {!cargando && !filas.length && <tr><td colSpan={7} className="p-6 text-center text-[var(--tenue)]">No hay traspasos {estado === "pendientes" ? "pendientes de recibir" : "con ese filtro"}.</td></tr>}
          </tbody>
        </table>
      </section>

      {recibir && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setRecibir(null)}>
          <div role="dialog" aria-label="Recibir traspaso" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-xl p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Recibir traspaso {recibir.t.serie} {recibir.t.folio}</h2>
            <p className="text-[var(--tenue)] mt-1">Si llegó todo, solo dale «Recibir». Si llegó menos, escribe lo que sí llegó: la diferencia queda registrada.</p>
            <table className="w-full mt-3">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]"><th className="py-1 font-normal">Producto</th><th className="font-normal text-right pr-2">Enviado</th><th className="font-normal">Llegó</th></tr></thead>
              <tbody>
                {recibir.t.traspaso_partidas.map((p) => (
                  <tr key={p.id} className="border-b border-[var(--borde)]">
                    <td className="py-1.5">{p.productos?.sku} - {p.productos?.nombre}</td>
                    <td className="text-right pr-2 whitespace-nowrap">{fmtCantidad(p.cantidad)} {p.unidades_venta?.nombre}</td>
                    <td className="py-1"><input className="campo !py-1 text-right w-24" inputMode="decimal" placeholder={fmtCantidad(p.cantidad)} value={recibir.cant[p.id] ?? ""}
                      onChange={(e) => setRecibir({ ...recibir, cant: { ...recibir.cant, [p.id]: e.target.value } })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setRecibir(null)}>Cerrar</button>
              <button className="btn-primario" disabled={trabajando} onClick={guardarRecepcion}>{trabajando ? "Guardando…" : "Recibir"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
