"use client";
/**
 * Ventas › Detalle de una venta guardada.
 * Al guardar se llega aquí, con las acciones del documento: imprimir (carta o ticket),
 * descargar PDF, enviar por correo / WhatsApp / compartir, nueva venta, facturar y cancelar.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, mxn } from "@/lib/unidades";
import { FORMAS_PAGO, VentaDoc, cargarVenta, emisorDe, fechaMx, folioDe, generarPdf, pendienteEntrega, resumenTexto, tituloDe } from "@/lib/documentoVenta";

type Formato = "carta" | "ticket80" | "ticket58";
const CLAVE_TICKET = "formato-ticket";

export default function DetalleVenta() {
  const { id } = useParams<{ id: string }>();

  const [v, setV] = useState<VentaDoc | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [ticket, setTicket] = useState<"ticket80" | "ticket58">("ticket80");

  const recargar = useCallback(async () => {
    try { setV(await cargarVenta(id)); } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [id]);

  useEffect(() => { recargar(); }, [recargar]);
  useEffect(() => {
    try { const t = localStorage.getItem(CLAVE_TICKET); if (t === "ticket58" || t === "ticket80") setTicket(t); } catch { /* sin almacenamiento */ }
    const params = new URLSearchParams(window.location.search);
    const cambio = params.get("cambio");
    if (params.get("nueva")) setMsg({ tipo: "ok", texto: `Venta guardada.${cambio && Number(cambio) > 0 ? ` Cambio: ${mxn(cambio)}.` : ""}` });
  }, []);

  const nombreArchivo = (f: Formato) => `${v ? folioDe(v) : "venta"}${f === "carta" ? "" : "-ticket"}.pdf`;

  const conPdf = async (f: Formato, fn: (b: Blob) => void | Promise<void>) => {
    if (!v) return;
    setTrabajando(true);
    try { await fn(await generarPdf(v, f)); } catch (e) { if ((e as Error).name !== "AbortError") setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setTrabajando(false); }
  };

  const imprimir = (f: Formato) => conPdf(f, (b) => {
    // Imprime el PDF tal cual en un marco oculto (mismo resultado que el archivo descargado)
    const url = URL.createObjectURL(b);
    const fr = document.createElement("iframe");
    fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    fr.src = url;
    fr.onload = () => { fr.contentWindow?.focus(); fr.contentWindow?.print(); setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 60_000); };
    document.body.appendChild(fr);
  });

  const descargar = (f: Formato) => conPdf(f, (b) => {
    const url = URL.createObjectURL(b);
    const a = Object.assign(document.createElement("a"), { href: url, download: nombreArchivo(f) });
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });

  const compartir = () => conPdf("carta", async (b) => {
    const archivo = new File([b], nombreArchivo("carta"), { type: "application/pdf" });
    if (navigator.canShare?.({ files: [archivo] })) await navigator.share({ files: [archivo], title: tituloDe(v!), text: resumenTexto(v!) });
    else setMsg({ tipo: "error", texto: "Este equipo no permite compartir archivos directamente. Usa “Descargar PDF” y adjúntalo." });
  });

  const correo = () => {
    if (!v) return;
    const asunto = encodeURIComponent(tituloDe(v));
    const cuerpo = encodeURIComponent(`${resumenTexto(v)}\n\n(Se adjunta el PDF.)`);
    window.location.href = `mailto:${v.cliente.correo_facturas ?? ""}?subject=${asunto}&body=${cuerpo}`;
    setMsg({ tipo: "ok", texto: "Se abrió tu programa de correo. Descarga el PDF y adjúntalo al mensaje." });
  };

  const whatsapp = () => {
    if (!v) return;
    const tel = (v.cliente.telefono ?? "").replace(/\D/g, "");
    const num = tel.length === 10 ? `52${tel}` : tel;
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(resumenTexto(v))}`, "_blank", "noopener");
  };

  const cancelar = async () => {
    if (!v) return;
    const motivo = window.prompt(`Cancelar la venta ${folioDe(v)}.\nEl inventario regresa al almacén y los pagos quedan anulados.\n\nMotivo de la cancelación:`);
    if (motivo === null) return;
    if (!motivo.trim()) { setMsg({ tipo: "error", texto: "El motivo es obligatorio." }); return; }
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cancelar_venta", { p_venta: v.id, p_motivo: motivo.trim() });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `Venta ${folioDe(v)} cancelada.` });
      await recargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  // Atajos: Ctrl+P imprimir, F2 nueva venta
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); imprimir(ticket); }
      if (e.key === "F2") { e.preventDefault(); window.location.href = "/ventas/capturar"; }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  if (cargando) return <div className="p-6 text-[var(--tenue)]">Cargando venta…</div>;
  if (!v) return (
    <div className="p-6">
      {msg?.tipo === "error"
        ? <div role="alert" className="mb-3 rounded px-4 py-2 bg-amber-100 text-amber-900">No se pudo abrir la venta: {msg.texto}</div>
        : <p className="mb-3">No se encontró la venta o no tienes acceso a su sucursal.</p>}
      <Link className="underline" href="/ventas/capturar">Nueva venta</Link>
    </div>
  );

  const cancelada = v.estado === "cancelada";
  const btn = "px-3 py-2 rounded border border-[var(--borde)] bg-[var(--panel)] hover:bg-[var(--resalte)] text-sm disabled:opacity-50";

  return (
    <div className="p-3 sm:p-5">
      {msg && (
        <div role="alert" className={`mb-3 rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>
      )}

      {/* Barra de acciones */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <Link href="/ventas/capturar" className="btn-primario" title="F2">Nueva venta</Link>
        <button className={btn} disabled={trabajando} onClick={() => imprimir(ticket)} title="Ctrl+P">🖨 Imprimir ticket</button>
        <select aria-label="Ancho del ticket" className="campo !w-auto text-sm" value={ticket} onChange={(e) => {
          const t = e.target.value as "ticket80" | "ticket58"; setTicket(t); try { localStorage.setItem(CLAVE_TICKET, t); } catch { /* ignorar */ }
        }}>
          <option value="ticket80">80 mm</option><option value="ticket58">58 mm</option>
        </select>
        <button className={btn} disabled={trabajando} onClick={() => imprimir("carta")}>🖨 Imprimir carta</button>
        <button className={btn} disabled={trabajando} onClick={() => descargar("carta")}>⬇ Descargar PDF</button>
        <button className={btn} disabled={trabajando} onClick={() => descargar(ticket)}>⬇ PDF ticket</button>
        <button className={btn} onClick={correo}>✉ Enviar por correo</button>
        <button className={btn} onClick={whatsapp}>WhatsApp</button>
        <button className={btn} disabled={trabajando} onClick={compartir}>Compartir</button>
        <span className="flex-1" />
        <button className={btn} disabled title="Disponible cuando se configure la facturación (CFDI)">Facturar</button>
        {!cancelada && (
          <button className={`${btn} !text-[var(--peligro)]`} disabled={trabajando || !!v.factura_uuid} onClick={cancelar}>Cancelar venta</button>
        )}
      </div>

      {/* Documento */}
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 sm:p-6 text-sm">
        <div className="flex flex-wrap justify-between gap-4">
          <div>
            <div className="font-semibold uppercase">{emisorDe(v)}</div>
            <div className="text-[var(--tenue)]">{v.sucursal.codigo} - {v.sucursal.nombre} · Almacén: {v.almacen}</div>
            <div className="mt-2"><span className="text-[var(--tenue)]">Cliente:</span> {v.cliente.razon_social || v.cliente.nombre}{v.cliente.rfc ? ` · ${v.cliente.rfc}` : ""}</div>
          </div>
          <div className="text-right">
            <div className="text-lg font-semibold">{tituloDe(v)}</div>
            <div>{fechaMx(v.fecha)} · {v.tipo === "credito" ? `Crédito${v.vencimiento ? `, vence ${v.vencimiento}` : ""}` : "Contado"}</div>
            <div className="mt-1 flex gap-2 justify-end">
              {cancelada
                ? <span className="px-2 rounded text-white" style={{ background: "var(--peligro)" }}>Cancelada</span>
                : <span className="px-2 rounded bg-emerald-100 text-emerald-900">Confirmada</span>}
              {!cancelada && pendienteEntrega(v) && <span className="px-2 rounded bg-amber-100 text-amber-900">Entrega pendiente</span>}
              {v.factura_uuid && <span className="px-2 rounded bg-sky-100 text-sky-900">Facturada</span>}
            </div>
            {cancelada && v.motivo_cancelacion && <div className="text-xs mt-1">Motivo: {v.motivo_cancelacion}</div>}
          </div>
        </div>

        <div className="overflow-x-auto mt-4">
          <table className="w-full min-w-[640px]">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left">
                <th className="py-1 font-normal">Código</th><th className="font-normal">Unidad</th><th className="font-normal">Concepto</th>
                <th className="font-normal text-right">Cant.</th><th className="font-normal text-right">Entregado</th>
                <th className="font-normal text-right">Precio</th><th className="font-normal text-right">Importe</th>
              </tr>
            </thead>
            <tbody>
              {v.partidas.map((p, i) => (
                <tr key={p.renglon} className="border-t border-[var(--borde)] align-top" style={{ background: i % 2 ? "transparent" : "#f7f9fb" }}>
                  <td className="py-2">{p.sku}</td>
                  <td>{p.unidad}</td>
                  <td>{p.nombre}
                    {p.unidad !== p.unidad_base && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(p.cantidad_base)} {p.unidad_base}</div>}
                    {p.vendida_sin_existencia && <div className="text-xs text-[var(--peligro)]">Vendida sin existencia suficiente</div>}
                  </td>
                  <td className="text-right">{fmtCantidad(p.cantidad)}</td>
                  <td className="text-right">{fmtCantidad(p.cantidad_entregada)}</td>
                  <td className="text-right">{Number(p.precio_unitario).toFixed(2)}</td>
                  <td className="text-right">{Number(p.total).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_280px] mt-4">
          <div>
            <div className="barra-seccion">Pagos</div>
            <ul className="mt-2">
              {v.pagos.length ? v.pagos.map((p, i) => (
                <li key={i}>{FORMAS_PAGO[p.forma] ?? p.forma}: {mxn(p.importe)}{p.referencia ? ` · ${p.referencia}` : ""}</li>
              )) : <li className="text-[var(--tenue)]">Sin pagos (venta a crédito)</li>}
            </ul>
            {v.comentarios && <><div className="mt-3 text-[var(--tenue)]">Comentarios</div><p className="whitespace-pre-wrap">{v.comentarios}</p></>}
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-y-1">
            <dt>Subtotal:</dt><dd className="text-right">{Number(v.subtotal).toFixed(2)}</dd>
            <dt>Descuento:</dt><dd className="text-right">{Number(v.descuento).toFixed(2)}</dd>
            {Number(v.ieps) > 0 && <><dt>I.E.P.S.:</dt><dd className="text-right">{Number(v.ieps).toFixed(2)}</dd></>}
            <dt>I.V.A.:</dt><dd className="text-right">{Number(v.iva).toFixed(2)}</dd>
            <dt className="font-semibold text-base">Total (MXN):</dt><dd className="text-right font-semibold text-base">{Number(v.total).toFixed(2)}</dd>
            <dt className="mt-2">Pagado:</dt><dd className="text-right mt-2">{Number(v.pagado).toFixed(2)}</dd>
            {v.tipo === "credito"
              ? <><dt>Saldo:</dt><dd className="text-right font-semibold">{Number(v.saldo).toFixed(2)}</dd></>
              : <><dt>Cambio:</dt><dd className="text-right font-semibold">{Number(v.cambio).toFixed(2)}</dd></>}
          </dl>
        </div>
      </section>
    </div>
  );
}
