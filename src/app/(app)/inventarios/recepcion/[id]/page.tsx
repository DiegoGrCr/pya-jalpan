"use client";
/** Detalle de una recepción de mercancía: renglones al costo, imprimir y cancelar (cancelar_entrada). */
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";
import { fechaMx, nombresUsuarios } from "@/lib/documentoVenta";

interface Entrada {
  id: string; serie: string; folio: number; fecha: string; documento_proveedor: string | null; comentarios: string | null;
  estado: "aplicada" | "cancelada"; total: string; subtotal: string; descuento: string; iva: string;
  tipo_documento: string | null; fecha_documento: string | null; dias_credito: number; usuario_id: string | null; cancelada_en: string | null; cancelada_por: string | null; motivo_cancelacion: string | null;
  proveedores: { nombre: string; rfc: string | null } | null; almacenes: { nombre: string } | null; sucursales: { codigo: string; nombre: string } | null;
  entrada_partidas: { id: string; cantidad: string; factor: string; cantidad_base: string; costo_unitario: string; iva_tasa: string;
    unidades_venta: { nombre: string } | null; productos: { sku: string; nombre: string; unidad_base: string; m2_por_caja: string | null; formato: string | null } | null }[];
}
const TIPO: Record<string, string> = { factura: "Factura", remision: "Remisión", otro: "Documento" };
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export default function DetalleRecepcion({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [e, setE] = useState<Entrada | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [cancelar, setCancelar] = useState<string | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const cargar = useCallback(async () => {
    const { data, error } = await supabase().from("entradas").select(`id, serie, folio, fecha, documento_proveedor, comentarios, estado, total, subtotal, descuento, iva, tipo_documento, fecha_documento, dias_credito, usuario_id,
      cancelada_en, cancelada_por, motivo_cancelacion, proveedores(nombre, rfc), almacenes(nombre), sucursales(codigo, nombre),
      entrada_partidas(id, cantidad, factor, cantidad_base, costo_unitario, iva_tasa, unidades_venta(nombre), productos(sku, nombre, unidad_base, m2_por_caja, formato))`)
      .eq("id", id).maybeSingle();
    if (error) { setMsg({ tipo: "error", texto: /total|cancelada|subtotal|tipo_documento|iva_tasa/.test(error.message) ? "Falta ejecutar la migración 20261120000047_recepcion_mercancia.sql en Supabase." : mensajeError(error) }); return; }
    if (!data) { setMsg({ tipo: "error", texto: "No se encontró la recepción o no tienes acceso a su sucursal." }); return; }
    const x = data as unknown as Entrada;
    setE(x);
    const ids = [x.usuario_id, x.cancelada_por].filter((v): v is string => !!v);
    if (ids.length) setNombres(await nombresUsuarios(ids));
  }, [id]);
  useEffect(() => {
    cargar();
    if (new URLSearchParams(window.location.search).get("nueva")) setMsg({ tipo: "ok", texto: "Recepción registrada: ya subieron las existencias." });
  }, [cargar]);

  const confirmarCancelacion = async () => {
    if (!cancelar?.trim()) return;
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cancelar_entrada", { p: { entrada_id: id, motivo: cancelar } });
      if (error) throw error;
      setCancelar(null); setMsg({ tipo: "ok", texto: "Recepción cancelada: la mercancía se descontó del almacén." }); await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); } finally { setTrabajando(false); }
  };

  const imprimir = () => {
    if (!e) return;
    const filas = e.entrada_partidas.map((p) => `<tr><td>${esc(p.productos?.sku)}</td><td>${esc(p.productos?.nombre)}</td><td class="r">${fmtCantidad(p.cantidad, 4)} ${esc(p.unidades_venta?.nombre)}</td>
      <td class="r">$${fmtImporte(p.costo_unitario)}</td><td class="r">$${fmtImporte(Number(p.cantidad) * Number(p.costo_unitario))}</td></tr>`).join("");
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Recepción ${esc(e.serie)} ${e.folio}</title><style>
      body{font-family:Arial,sans-serif;font-size:11px;color:#1d2b2a;margin:24px}h1{color:#0f766e;font-size:18px;margin:0 0 4px}
      table{width:100%;border-collapse:collapse;margin-top:12px}th{background:#0f766e;color:#fff;text-align:left;padding:5px;font-weight:normal}
      td{padding:4px 5px;border-bottom:1px solid #dfe7e5}.r{text-align:right}.t{font-weight:bold;font-size:13px}
      .firmas{display:flex;gap:60px;margin-top:60px}.firmas div{flex:1;border-top:1px solid #000;text-align:center;padding-top:4px}</style></head><body>
      <h1>Recepción de mercancía ${esc(e.serie)} ${e.folio}${e.estado === "cancelada" ? " (CANCELADA)" : ""}</h1>
      <div>${esc(e.sucursales?.codigo)} - ${esc(e.sucursales?.nombre)} · Almacén: ${esc(e.almacenes?.nombre)} · ${fechaMx(e.fecha)}</div>
      <div>Proveedor: ${esc(e.proveedores?.nombre ?? "—")} · ${esc(TIPO[e.tipo_documento ?? ""] ?? "Documento")}: ${esc(e.documento_proveedor ?? "—")}${e.fecha_documento ? ` del ${esc(e.fecha_documento.split("-").reverse().join("/"))}` : ""}${e.dias_credito ? ` · Crédito: ${e.dias_credito} días` : ""}</div>
      <table><thead><tr><th>SKU</th><th>Producto</th><th class="r">Cantidad</th><th class="r">Costo unit.</th><th class="r">Importe</th></tr></thead>
      <tbody>${filas}</tbody><tfoot>
        <tr><td colspan="4" class="r">Subtotal</td><td class="r">$${fmtImporte(e.subtotal)}</td></tr>
        ${Number(e.descuento) ? `<tr><td colspan="4" class="r">Descuento</td><td class="r">−$${fmtImporte(e.descuento)}</td></tr>` : ""}
        <tr><td colspan="4" class="r">I.V.A.</td><td class="r">$${fmtImporte(e.iva)}</td></tr>
        <tr class="t"><td colspan="4" class="r">Total</td><td class="r">$${fmtImporte(e.total)}</td></tr></tfoot></table>
      ${e.comentarios ? `<p>Comentarios: ${esc(e.comentarios)}</p>` : ""}
      <div class="firmas"><div>Entregó (proveedor)</div><div>Recibió</div></div></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 300);
  };

  if (!e) return <div className="p-5">{msg ? <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div> : "Cargando…"}</div>;
  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Recepción {e.serie} {e.folio}
          {e.estado === "cancelada"
            ? <span className="ml-2 align-middle px-2 rounded text-sm bg-gray-200 text-gray-700">Cancelada</span>
            : <span className="ml-2 align-middle px-2 rounded text-sm bg-emerald-100 text-emerald-900">Aplicada</span>}</h1>
        <div className="flex gap-2">
          <Link href="/inventarios/recepcion" className="px-3 py-2 underline text-sm">← Volver</Link>
          <button className="px-3 py-2 rounded border border-[var(--borde)] text-sm" onClick={imprimir}>Imprimir</button>
          {e.estado === "aplicada" && <button className="px-3 py-2 rounded border border-[var(--peligro)] text-[var(--peligro)] text-sm" onClick={() => setCancelar("")}>Cancelar recepción</button>}
        </div>
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        <div><span className="text-[var(--tenue)]">Fecha:</span> {fechaMx(e.fecha)}</div>
        <div><span className="text-[var(--tenue)]">Almacén:</span> {e.sucursales?.codigo} · {e.almacenes?.nombre}</div>
        <div><span className="text-[var(--tenue)]">Recibió:</span> {e.usuario_id ? nombres[e.usuario_id] ?? "" : ""}</div>
        <div><span className="text-[var(--tenue)]">Proveedor:</span> {e.proveedores?.nombre ?? "—"}</div>
        <div><span className="text-[var(--tenue)]">{TIPO[e.tipo_documento ?? ""] ?? "Documento"}:</span> {e.documento_proveedor ?? "—"}
          {e.fecha_documento && <> del {e.fecha_documento.split("-").reverse().join("/")}</>}</div>
        {e.dias_credito > 0 && <div><span className="text-[var(--tenue)]">Días de crédito:</span> {e.dias_credito}</div>}
        {e.comentarios && <div><span className="text-[var(--tenue)]">Comentarios:</span> {e.comentarios}</div>}
        {e.estado === "cancelada" && (
          <div className="sm:col-span-2 lg:col-span-3 text-[var(--peligro)]">Cancelada el {e.cancelada_en ? fechaMx(e.cancelada_en) : ""}
            {e.cancelada_por ? ` por ${nombres[e.cancelada_por] ?? ""}` : ""} · Motivo: {e.motivo_cancelacion}</div>
        )}
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[700px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">SKU</th><th className="font-normal">Producto</th><th className="font-normal text-right pr-3">Cantidad</th>
            <th className="font-normal text-right pr-3">Costo unit.</th><th className="font-normal text-right pr-3">IVA</th><th className="font-normal text-right pr-3">Importe</th></tr></thead>
          <tbody>
            {e.entrada_partidas.map((p) => (
              <tr key={p.id} className="border-b border-[var(--borde)]">
                <td className="p-2 font-mono">{p.productos?.sku}</td>
                <td>{p.productos ? nombreConCaja(p.productos.nombre, p.productos.m2_por_caja, p.productos.formato) : ""}</td>
                <td className="text-right pr-3 whitespace-nowrap">{fmtCantidad(p.cantidad, 4)} {p.unidades_venta?.nombre}
                  {Number(p.factor) !== 1 && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(p.cantidad_base, 4)} {p.productos?.unidad_base}</div>}</td>
                <td className="text-right pr-3">${fmtImporte(p.costo_unitario)}</td>
                <td className="text-right pr-3">{Math.round(Number(p.iva_tasa) * 100)}%</td>
                <td className="text-right pr-3">${fmtImporte(Number(p.cantidad) * Number(p.costo_unitario))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr><td colSpan={5} className="pt-2 px-2 text-right">Subtotal</td><td className="pt-2 text-right pr-3">${fmtImporte(e.subtotal)}</td></tr>
            {Number(e.descuento) > 0 && <tr><td colSpan={5} className="px-2 text-right">Descuento</td><td className="text-right pr-3">−${fmtImporte(e.descuento)}</td></tr>}
            <tr><td colSpan={5} className="px-2 text-right">I.V.A.</td><td className="text-right pr-3">${fmtImporte(e.iva)}</td></tr>
            <tr className="font-semibold"><td colSpan={5} className="p-2 text-right">Total</td><td className="text-right pr-3">${fmtImporte(e.total)}</td></tr>
          </tfoot>
        </table>
      </section>

      {cancelar !== null && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setCancelar(null)}>
          <div role="dialog" aria-label="Cancelar recepción" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(ev) => ev.stopPropagation()}>
            <h2 className="text-lg font-semibold">Cancelar recepción {e.serie} {e.folio}</h2>
            <p className="mt-1 text-[var(--tenue)]">La mercancía se descuenta del almacén y se revierte el costo promedio. Solo se puede si la mercancía sigue en el almacén.</p>
            <label className="block mt-3">Motivo<input className="campo" autoFocus value={cancelar} onChange={(ev) => setCancelar(ev.target.value)} /></label>
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setCancelar(null)}>No cancelar</button>
              <button className="btn-primario" style={{ background: "var(--peligro)" }} disabled={trabajando || !cancelar.trim()} onClick={confirmarCancelacion}>{trabajando ? "Cancelando…" : "Cancelar recepción"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
