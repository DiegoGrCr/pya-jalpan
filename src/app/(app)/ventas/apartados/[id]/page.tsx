"use client";
/**
 * Detalle de un apartado: material reservado, lo abonado y el saldo, historial de pagos.
 * Acciones: abonar, liquidar (convertir en venta), imprimir el comprobante y cancelar
 * (quien cancela decide cuánto retener y si el resto se devuelve o queda a favor).
 */
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { EsqueletoFicha } from "@/components/Esqueleto";

interface Apartado {
  id: string; serie: string; folio: number; fecha: string; estado: "abierto" | "liquidado" | "cancelado";
  subtotal: string; descuento: string; iva: string; total: string; abonado: string; saldo: string; comentarios: string | null;
  venta_id: string | null; vendedor_id: string | null; retenido: string | null; devuelto: string | null; motivo_cancelacion: string | null;
  cancelado_en: string | null; cancelado_por: string | null; cancelacion_destino?: string | null;
  clientes: { id: string; nombre: string; razon_social: string | null; telefono: string | null } | null;
  sucursales: { codigo: string; nombre: string } | null; almacenes: { nombre: string } | null;
  apartado_partidas: { id: string; renglon: number; cantidad: string; unidad_nombre: string; precio_unitario: string; descuento: string; total: string;
    descripcion?: string | null; comentario?: string | null;
    productos: { sku: string; nombre: string; m2_por_caja: string | null; formato: string | null } | null }[];
}
interface Pago { id: string; tipo: "anticipo" | "abono" | "devolucion"; forma: string; importe: string; referencia: string | null; fecha: string; usuario_id: string | null }
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const $ = (n: string | number) => `$${fmtImporte(Number(n))}`;
const tz = { timeZone: "America/Mexico_City" } as const;
const diasDesde = (iso: string) => {
  const hoy = new Date().toLocaleDateString("en-CA", tz), f = new Date(iso).toLocaleDateString("en-CA", tz);
  return Math.round((new Date(`${hoy}T12:00:00`).getTime() - new Date(`${f}T12:00:00`).getTime()) / 86_400_000);
};
const FORMAS = ["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito"] as const;

export default function DetalleApartado({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [a, setA] = useState<Apartado | null>(null);
  const [pagos, setPagos] = useState<Pago[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [aviso, setAviso] = useState(15);
  const [puedeCancelar, setPuedeCancelar] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [abono, setAbono] = useState<{ clave: string; forma: string; importe: string; referencia: string } | null>(null);
  const [cancelar, setCancelar] = useState<{ motivo: string; retener: string; destino: "dinero" | "saldo_favor"; forma: string } | null>(null);

  const cargar = useCallback(async () => {
    const sb = supabase();
    const base = `id, serie, folio, fecha, estado, subtotal, descuento, iva, total, abonado, saldo, comentarios, venta_id, vendedor_id, retenido, devuelto,
      motivo_cancelacion, cancelado_en, cancelado_por, clientes(id, nombre, razon_social, telefono), sucursales(codigo, nombre), almacenes(nombre)`;
    let r = await sb.from("apartados").select(`${base}, cancelacion_destino,
      apartado_partidas(id, renglon, cantidad, unidad_nombre, precio_unitario, descuento, total, descripcion, comentario, productos(sku, nombre, m2_por_caja, formato))`).eq("id", id).maybeSingle();
    if (r.error) r = await sb.from("apartados").select(`${base},
      apartado_partidas(id, renglon, cantidad, unidad_nombre, precio_unitario, descuento, total, productos(sku, nombre, m2_por_caja, formato))`).eq("id", id).maybeSingle();
    if (r.error) { setMsg({ tipo: "error", texto: mensajeError(r.error) }); return; }
    if (!r.data) { setMsg({ tipo: "error", texto: "No se encontró el apartado o no tienes acceso a su sucursal." }); return; }
    const ap = r.data as unknown as Apartado;
    ap.apartado_partidas.sort((x, y) => x.renglon - y.renglon);
    setA(ap);
    const { data: pg } = await sb.from("apartado_pagos").select("id, tipo, forma, importe, referencia, fecha, usuario_id").eq("apartado_id", id).order("fecha");
    const lista = (pg ?? []) as Pago[];
    setPagos(lista);
    const ids = [ap.vendedor_id, ap.cancelado_por, ...lista.map((x) => x.usuario_id)].filter((x): x is string => !!x);
    if (ids.length) setNombres(await nombresUsuarios(ids));
  }, [id]);
  useEffect(() => {
    cargar();
    const sb = supabase();
    sb.rpc("tiene_permiso", { p_permiso: "cancelar_apartados" }).then(({ data }: { data: unknown }) => setPuedeCancelar(data === true));
    sb.from("empresa").select("apartado_dias_aviso").eq("id", 1).maybeSingle()
      .then(({ data }: { data: unknown }) => { const d = (data as { apartado_dias_aviso?: number } | null)?.apartado_dias_aviso; if (d) setAviso(d); });
    if (new URLSearchParams(window.location.search).get("nuevo")) setMsg({ tipo: "ok", texto: "Apartado guardado. El material quedó reservado." });
  }, [cargar]);

  const guardarAbono = async () => {
    if (!abono || !a) return;
    setTrabajando(true); setMsg(null);
    try {
      const { error } = await supabase().rpc("abonar_apartado", { p: { apartado_id: a.id, forma: abono.forma, importe: abono.importe, referencia: abono.referencia || null, idempotency_key: abono.clave } });
      if (error) throw error;
      setAbono(null); setMsg({ tipo: "ok", texto: `Abono de ${$(abono.importe)} registrado.` }); await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const guardarCancelacion = async () => {
    if (!cancelar || !a) return;
    setTrabajando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("cancelar_apartado", { p: { apartado_id: a.id, motivo: cancelar.motivo, retener: Number(cancelar.retener) || 0,
        destino: cancelar.destino, forma: cancelar.forma } });
      if (error) {
        if (/cancelar_apartado/.test(error.message) && /function|función/i.test(error.message)) throw new Error("Falta ejecutar la migración 20261123000052_apartados_reglas.sql en Supabase.");
        throw error;
      }
      const d = data as { retenido: number; devuelto: number; destino: string };
      setCancelar(null);
      setMsg({ tipo: "ok", texto: `Apartado cancelado. ${Number(d.devuelto) > 0 ? (d.destino === "saldo_favor" ? `${$(d.devuelto)} quedaron como saldo a favor del cliente.` : `Se devuelven ${$(d.devuelto)}.`) : "No hay nada que devolver."}${Number(d.retenido) > 0 ? ` Se retuvieron ${$(d.retenido)}.` : ""}` });
      await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const imprimir = () => {
    if (!a) return;
    const filas = a.apartado_partidas.map((p) => `<tr><td>${esc(p.productos?.sku)}</td><td>${esc(p.descripcion || nombreConCaja(p.productos?.nombre ?? "", p.productos?.m2_por_caja ?? null, p.productos?.formato ?? null))}${p.comentario ? `<br><small>${esc(p.comentario)}</small>` : ""}</td>
      <td class="r">${fmtCantidad(p.cantidad)} ${esc(p.unidad_nombre)}</td><td class="r">${$(p.precio_unitario)}</td><td class="r">${$(p.total)}</td></tr>`).join("");
    const movs = pagos.map((x) => `<tr><td>${fechaMx(x.fecha)}</td><td>${x.tipo === "anticipo" ? "Anticipo" : x.tipo === "abono" ? "Abono" : "Devolución"}</td><td>${esc(FORMAS_PAGO[x.forma] ?? x.forma)}</td><td class="r">${x.tipo === "devolucion" ? "−" : ""}${$(x.importe)}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Apartado ${esc(a.serie)} ${a.folio}</title><style>
      body{font-family:Arial,sans-serif;font-size:11px;color:#1d2b2a;margin:24px}h1{color:#0f766e;font-size:18px;margin:0 0 4px}h2{font-size:13px;margin:16px 0 0}
      table{width:100%;border-collapse:collapse;margin-top:8px}th{background:#0f766e;color:#fff;text-align:left;padding:5px;font-weight:normal}
      td{padding:4px 5px;border-bottom:1px solid #dfe7e5}.r{text-align:right}.t{font-weight:bold;font-size:13px}.nota{margin-top:14px;padding:8px;border:1px solid #dfe7e5}
      .firmas{display:flex;gap:60px;margin-top:60px}.firmas div{flex:1;border-top:1px solid #000;text-align:center;padding-top:4px}</style></head><body>
      <h1>Comprobante de apartado ${esc(a.serie)} ${a.folio}${a.estado === "cancelado" ? " (CANCELADO)" : a.estado === "liquidado" ? " (LIQUIDADO)" : ""}</h1>
      <div>${esc(a.sucursales?.codigo)} - ${esc(a.sucursales?.nombre)} · ${fechaMx(a.fecha)}</div>
      <div>Cliente: <b>${esc(a.clientes?.razon_social || a.clientes?.nombre)}</b>${a.clientes?.telefono ? ` · Tel. ${esc(a.clientes.telefono)}` : ""}</div>
      <table><thead><tr><th>Código</th><th>Producto</th><th class="r">Cantidad</th><th class="r">Precio</th><th class="r">Importe</th></tr></thead>
      <tbody>${filas}</tbody><tfoot>
        <tr class="t"><td colspan="4" class="r">Total</td><td class="r">${$(a.total)}</td></tr>
        <tr><td colspan="4" class="r">Abonado</td><td class="r">${$(a.abonado)}</td></tr>
        <tr class="t"><td colspan="4" class="r">Saldo</td><td class="r">${$(a.saldo)}</td></tr></tfoot></table>
      ${movs ? `<h2>Pagos</h2><table><thead><tr><th>Fecha</th><th>Concepto</th><th>Forma</th><th class="r">Importe</th></tr></thead><tbody>${movs}</tbody></table>` : ""}
      ${a.comentarios ? `<p>Comentarios: ${esc(a.comentarios)}</p>` : ""}
      <div class="nota">El material queda reservado con el precio de este comprobante. Presente este comprobante para abonar o liquidar.</div>
      <div class="firmas"><div>Cliente</div><div>Atendió</div></div></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  if (!a) return msg ? <div className="p-5"><div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div></div> : <EsqueletoFicha />;
  const dias = diasDesde(a.fecha);
  const abierto = a.estado === "abierto";
  const viejo = abierto && dias >= aviso;

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Apartado {a.serie} {a.folio}
          {a.estado === "cancelado" ? <span className="ml-2 align-middle px-2 rounded text-sm bg-gray-200 text-gray-700">Cancelado</span>
            : a.estado === "liquidado" ? <span className="ml-2 align-middle px-2 rounded text-sm bg-emerald-100 text-emerald-900">Liquidado</span>
            : <span className={`ml-2 align-middle px-2 rounded text-sm ${viejo ? "bg-red-100 text-red-800" : "bg-amber-100 text-amber-900"}`}>Abierto · {dias === 0 ? "hoy" : `${dias} día${dias === 1 ? "" : "s"}`}</span>}</h1>
        <div className="flex gap-2 flex-wrap">
          <Link href="/ventas/apartados" className="px-3 py-2 underline text-sm">← Apartados</Link>
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" onClick={imprimir}>Imprimir comprobante</button>
          {abierto && <button className="px-3 py-2 rounded border border-[var(--acento)] text-[var(--acento)] text-sm"
            onClick={() => setAbono({ clave: crypto.randomUUID(), forma: "efectivo", importe: "", referencia: "" })}>Abonar</button>}
          {abierto && <Link href={`/ventas/capturar?liquidar=${a.id}`} className="btn-primario text-sm">Liquidar (vender)</Link>}
          {abierto && puedeCancelar && <button className="px-3 py-2 rounded border border-[var(--peligro)] text-[var(--peligro)] text-sm"
            onClick={() => setCancelar({ motivo: "", retener: "", destino: "dinero", forma: "efectivo" })}>Cancelar apartado</button>}
        </div>
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}
      {viejo && <div role="alert" className="rounded px-4 py-2 bg-red-50 text-red-800 border border-red-200">
        Este apartado lleva {dias} días abierto. Comunícate con el cliente{a.clientes?.telefono ? ` (${a.clientes.telefono})` : ""} para que liquide o decida si lo cancela.</div>}
      {a.estado === "liquidado" && a.venta_id && <div className="rounded px-4 py-2 bg-emerald-50 text-emerald-900 text-sm">
        Se liquidó y se convirtió en venta: <Link className="underline font-semibold" href={`/ventas/${a.venta_id}`}>ver la nota</Link>.</div>}
      {a.estado === "cancelado" && <div className="rounded px-4 py-2 bg-gray-100 text-gray-800 text-sm">
        Cancelado el {a.cancelado_en ? fechaMx(a.cancelado_en) : ""}{a.cancelado_por ? ` por ${nombres[a.cancelado_por] ?? ""}` : ""}. Motivo: {a.motivo_cancelacion}.
        {Number(a.retenido) > 0 && <> Se retuvo {$(a.retenido ?? 0)}.</>}
        {Number(a.devuelto) > 0 && <> {a.cancelacion_destino === "saldo_favor" ? `${$(a.devuelto ?? 0)} quedaron como saldo a favor.` : `Se devolvieron ${$(a.devuelto ?? 0)}.`}</>}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        <div><span className="text-[var(--tenue)]">Cliente:</span> {a.clientes ? <Link className="underline" href={`/ventas/clientes/${a.clientes.id}`}>{a.clientes.razon_social || a.clientes.nombre}</Link> : "—"}
          {a.clientes?.telefono && <span className="text-[var(--tenue)]"> · {a.clientes.telefono}</span>}</div>
        <div><span className="text-[var(--tenue)]">Fecha:</span> {fechaMx(a.fecha)}</div>
        <div><span className="text-[var(--tenue)]">Sucursal / almacén:</span> {a.sucursales?.codigo} · {a.almacenes?.nombre}</div>
        <div><span className="text-[var(--tenue)]">Atendió:</span> {a.vendedor_id ? nombres[a.vendedor_id] ?? "" : ""}</div>
        {a.comentarios && <div className="sm:col-span-2"><span className="text-[var(--tenue)]">Comentarios:</span> {a.comentarios}</div>}
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Código</th><th className="font-normal">Producto</th><th className="font-normal text-right pr-3">Cantidad</th>
            <th className="font-normal text-right pr-3">Precio</th><th className="font-normal text-right pr-3">Descuento</th><th className="font-normal text-right pr-2">Importe</th></tr></thead>
          <tbody>
            {a.apartado_partidas.map((p) => (
              <tr key={p.id} className="border-b border-[var(--borde)] align-top">
                <td className="p-2 font-mono whitespace-nowrap">{p.productos?.sku}</td>
                <td className="py-2">{p.descripcion || nombreConCaja(p.productos?.nombre ?? "", p.productos?.m2_por_caja ?? null, p.productos?.formato ?? null)}
                  {p.comentario && <div className="text-xs text-[var(--tenue)]">{p.comentario}</div>}</td>
                <td className="py-2 pr-3 text-right whitespace-nowrap">{fmtCantidad(p.cantidad)} {p.unidad_nombre}</td>
                <td className="py-2 pr-3 text-right">{$(p.precio_unitario)}</td>
                <td className="py-2 pr-3 text-right">{Number(p.descuento) > 0 ? $(p.descuento) : "—"}</td>
                <td className="py-2 pr-2 text-right">{$(p.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 p-4 ml-auto max-w-xs text-sm">
          {Number(a.descuento) > 0 && <><dt>Descuento:</dt><dd className="text-right">{$(a.descuento)}</dd></>}
          {Number(a.iva) > 0 && <><dt>I.V.A.:</dt><dd className="text-right">{$(a.iva)}</dd></>}
          <dt className="font-semibold">Total:</dt><dd className="text-right font-semibold">{$(a.total)}</dd>
          <dt>Abonado:</dt><dd className="text-right">{$(a.abonado)}</dd>
          {abierto && <><dt className="font-semibold">Saldo:</dt><dd className="text-right font-semibold text-amber-700">{$(a.saldo)}</dd></>}
        </dl>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 text-sm">
        <h2 className="font-medium mb-2">Pagos</h2>
        <table className="w-full">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="py-1 font-normal">Fecha</th><th className="font-normal">Concepto</th><th className="font-normal">Forma / referencia</th><th className="font-normal">Registró</th><th className="font-normal text-right">Importe</th></tr></thead>
          <tbody>
            {pagos.map((x) => (
              <tr key={x.id} className="border-b border-[var(--borde)]">
                <td className="py-1.5 pr-3 whitespace-nowrap">{fechaMx(x.fecha)}</td>
                <td className="pr-3">{x.tipo === "anticipo" ? "Anticipo" : x.tipo === "abono" ? "Abono" : "Devolución por cancelación"}</td>
                <td className="pr-3">{[FORMAS_PAGO[x.forma] ?? x.forma, x.referencia ?? ""].filter(Boolean).join(" · ")}</td>
                <td className="pr-3">{x.usuario_id ? nombres[x.usuario_id] ?? "" : ""}</td>
                <td className={`text-right ${x.tipo === "devolucion" ? "text-[var(--peligro)]" : ""}`}>{x.tipo === "devolucion" ? "−" : ""}{$(x.importe)}</td>
              </tr>
            ))}
            {!pagos.length && <tr><td colSpan={5} className="py-3 text-[var(--tenue)]">Sin pagos: se apartó sin anticipo.</td></tr>}
          </tbody>
        </table>
      </section>

      {abono && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setAbono(null)}>
          <div role="dialog" aria-label="Abonar al apartado" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Abonar al apartado {a.serie} {a.folio}</h2>
            <p className="text-[var(--tenue)] mt-1">Saldo: <b>{$(a.saldo)}</b>. El abono entra al corte de caja de hoy.</p>
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              <label>Importe<input className="campo" inputMode="decimal" autoFocus value={abono.importe} onChange={(e) => setAbono({ ...abono, importe: e.target.value })} /></label>
              <label>Forma de pago
                <select className="campo" value={abono.forma} onChange={(e) => setAbono({ ...abono, forma: e.target.value })}>
                  {FORMAS.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f]}</option>)}
                </select>
              </label>
              <label className="sm:col-span-2">Referencia (opcional)<input className="campo" value={abono.referencia} onChange={(e) => setAbono({ ...abono, referencia: e.target.value })} /></label>
            </div>
            {Number(abono.importe) >= Number(a.saldo) && Number(abono.importe) > 0 && (
              <p className="text-xs text-amber-800 mt-2">Con este abono queda pagado. Después usa <b>Liquidar (vender)</b> para convertirlo en venta y entregar el material.</p>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setAbono(null)}>Cancelar</button>
              <button className="btn-primario" disabled={trabajando || !(Number(abono.importe) > 0) || Number(abono.importe) > Number(a.saldo)} onClick={guardarAbono}>
                {trabajando ? "Guardando…" : "Registrar abono"}</button>
            </div>
          </div>
        </div>
      )}

      {cancelar && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setCancelar(null)}>
          <div role="dialog" aria-label="Cancelar apartado" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Cancelar apartado {a.serie} {a.folio}</h2>
            <p className="text-[var(--tenue)] mt-1">El material deja de estar reservado. Abonado: <b>{$(a.abonado)}</b>.</p>
            <label className="block mt-3">Motivo *
              <input className="campo" autoFocus value={cancelar.motivo} onChange={(e) => setCancelar({ ...cancelar, motivo: e.target.value })} placeholder="p. ej. El cliente ya no lo quiere" />
            </label>
            {Number(a.abonado) > 0 && (() => {
              const ret = Math.min(Math.max(Number(cancelar.retener) || 0, 0), Number(a.abonado));
              const resto = Number(a.abonado) - ret;
              return <>
                <label className="block mt-3">¿Cuánto se retiene? (de $0 a {$(a.abonado)})
                  <input className="campo" inputMode="decimal" placeholder="0" value={cancelar.retener} onChange={(e) => setCancelar({ ...cancelar, retener: e.target.value })} />
                  <span className="text-xs text-[var(--tenue)]">A tu criterio: 0 si se le regresa todo.</span>
                </label>
                {resto > 0 && <div className="mt-3 flex flex-col gap-1">
                  <div>El resto, <b>{$(resto)}</b>:</div>
                  <label className="flex items-center gap-2"><input type="radio" checked={cancelar.destino === "dinero"} onChange={() => setCancelar({ ...cancelar, destino: "dinero" })} /> Se le devuelve
                    {cancelar.destino === "dinero" && <select className="campo !py-1 !w-auto" value={cancelar.forma} onChange={(e) => setCancelar({ ...cancelar, forma: e.target.value })}>
                      {FORMAS.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f]}</option>)}</select>}
                  </label>
                  <label className="flex items-center gap-2"><input type="radio" checked={cancelar.destino === "saldo_favor"} onChange={() => setCancelar({ ...cancelar, destino: "saldo_favor" })} /> Queda como saldo a favor del cliente</label>
                </div>}
              </>;
            })()}
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setCancelar(null)}>Volver</button>
              <button className="px-4 py-2 rounded text-white" style={{ background: "var(--peligro)" }}
                disabled={trabajando || !cancelar.motivo.trim() || Number(cancelar.retener) < 0 || Number(cancelar.retener) > Number(a.abonado)} onClick={guardarCancelacion}>
                {trabajando ? "Cancelando…" : "Cancelar apartado"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
