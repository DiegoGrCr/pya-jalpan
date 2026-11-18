"use client";
/**
 * Ventas › Cotizaciones › Detalle. Como en las notas: barra con el folio y "Acciones"
 * (generar venta, editar, copiar, PDF, imprimir, WhatsApp/imagen, cancelar), datos, productos y totales.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, fmtPrecio, nombreConCaja } from "@/lib/unidades";
import { CotizacionDoc, archivoDe, cargarCotizacion, fechaMx, folioDe, generarPdf, resumenTexto, tituloDe } from "@/lib/documentoVenta";
import { copiarImagen, pdfAPng } from "@/lib/notaImagen";
import { estatusCotizacion } from "@/lib/cotizaciones";

const MOTIVOS = ["El cliente ya no lo quiere", "Se capturó dos veces", "Se hizo otra cotización", "Otro"];

export default function DetalleCotizacion() {
  const { id } = useParams<{ id: string }>();
  const [v, setV] = useState<CotizacionDoc | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [menu, setMenu] = useState(false);
  const [cancelacion, setCancelacion] = useState<{ motivo: string; detalle: string } | null>(null);

  const recargar = useCallback(async () => {
    try { setV(await cargarCotizacion(id)); } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [id]);
  useEffect(() => { recargar(); }, [recargar]);
  useEffect(() => { if (new URLSearchParams(window.location.search).get("guardada")) setMsg({ tipo: "ok", texto: "Cotización guardada." }); }, []);
  useEffect(() => { if (msg?.tipo !== "ok") return; const t = setTimeout(() => setMsg(null), 3500); return () => clearTimeout(t); }, [msg]);
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[aria-haspopup='menu'], [role='menu']")) setMenu(false); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [menu]);

  const conPdf = async (fn: (b: Blob) => void | Promise<void>, formato: "carta" | "ticket80" = "carta") => {
    if (!v) return;
    setTrabajando(true);
    try { await fn(await generarPdf(v, formato)); } catch (e) { if ((e as Error).name !== "AbortError") setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setTrabajando(false); }
  };
  const descargar = () => conPdf((b) => {
    const url = URL.createObjectURL(b);
    Object.assign(document.createElement("a"), { href: url, download: `${archivoDe(v!)}.pdf` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  });
  const imprimir = () => conPdf((b) => {
    const url = URL.createObjectURL(b);
    const fr = document.createElement("iframe");
    fr.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    fr.src = url;
    fr.onload = () => { fr.contentWindow?.focus(); fr.contentWindow?.print(); setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 60_000); };
    document.body.appendChild(fr);
  });
  /** Celular: menú de compartir con el PDF; computadora: la cotización se copia como imagen y se abre WhatsApp. */
  const whatsapp = () => conPdf(async (pdf) => {
    const tel = (v!.cliente.telefono ?? "").replace(/\D/g, "");
    const num = tel.length === 10 ? `52${tel}` : tel;
    const movil = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && typeof navigator.canShare === "function";
    const archivo = new File([pdf], `${archivoDe(v!)}.pdf`, { type: "application/pdf" });
    if (movil && navigator.canShare({ files: [archivo] })) { await navigator.share({ files: [archivo], title: tituloDe(v!) }); return; }
    const copiada = await copiarImagen(await pdfAPng(pdf));
    const w = window.open(`https://wa.me/${num}`, "_blank"); if (w) w.opener = null;
    setMsg(copiada ? { tipo: "ok", texto: "Cotización copiada como imagen. En el chat de WhatsApp presiona Ctrl+V y envía." }
      : { tipo: "error", texto: "Este navegador no permite copiar la imagen. Descarga el PDF y adjúntalo." });
  });
  const correo = () => {
    if (!v) return;
    window.location.href = `mailto:${v.cliente.correo_facturas ?? ""}?subject=${encodeURIComponent(tituloDe(v))}&body=${encodeURIComponent(`${resumenTexto(v)}\n\n(Se adjunta el PDF.)`)}`;
  };
  const confirmarCancelacion = async () => {
    if (!v || !cancelacion?.motivo) return;
    if (cancelacion.motivo === "Otro" && !cancelacion.detalle.trim()) { setMsg({ tipo: "error", texto: "Escribe el motivo." }); return; }
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cancelar_cotizacion", { p: { id: v.id, motivo: [cancelacion.motivo, cancelacion.detalle.trim()].filter(Boolean).join(": ") } });
      if (error) {
        if (/cancelar_cotizacion/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000037_cotizaciones.sql en Supabase.");
        throw error;
      }
      setCancelacion(null); setMsg({ tipo: "ok", texto: `Cotización ${folioDe(v)} cancelada.` });
      await recargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  if (cargando) return <div className="p-6 text-[var(--tenue)]">Cargando cotización…</div>;
  if (!v) return (
    <div className="p-6">
      {msg?.tipo === "error" ? <div role="alert" className="mb-3 rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>
        : <p className="mb-3">No se encontró la cotización o no tienes acceso a su sucursal.</p>}
      <Link className="underline" href="/ventas/cotizaciones">← Cotizaciones</Link>
    </div>
  );

  const abierta = v.estadoCotizacion === "borrador" || v.estadoCotizacion === "enviada";
  const est = estatusCotizacion({ estado: v.estadoCotizacion, vigencia: v.vigencia ?? null });
  const ir = (url: string) => () => { window.location.href = url; };
  const acciones: { texto: string; fn?: () => void; deshabilitado?: boolean; peligro?: boolean }[] = [
    ...(abierta ? [{ texto: "Generar venta", fn: ir(`/ventas/capturar?desde_cotizacion=${v.id}`) }, { texto: "Editar", fn: ir(`/ventas/capturar?cotizacion=${v.id}`) }] : []),
    { texto: "Copiar (nueva cotización)", fn: ir(`/ventas/capturar?copiar_cotizacion=${v.id}`) },
    { texto: "Descargar PDF", fn: descargar }, { texto: "Imprimir", fn: imprimir },
    { texto: "Enviar por WhatsApp", fn: whatsapp }, { texto: "Enviar por correo", fn: correo },
    ...(abierta ? [{ texto: "Cancelar cotización", fn: () => setCancelacion({ motivo: "", detalle: "" }), peligro: true }] : []),
  ];
  const Dato = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <div className="py-0.5"><span className="font-medium">{k}:</span> <span className="text-[var(--tenue)]">{children}</span></div>
  );

  return (
    <div className="p-3 sm:p-5">
      {msg && (msg.tipo === "ok"
        ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-md px-4 py-2 text-sm shadow-lg bg-emerald-600 text-white">✓ {msg.texto}</div>
        : <div role="alert" className="mb-3 rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>)}

      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <Link href="/ventas/capturar?cotizar=1" className="btn-primario">Nueva cotización</Link>
        {abierta && <Link href={`/ventas/capturar?desde_cotizacion=${v.id}`} className="px-3 py-2 rounded border border-emerald-600 text-emerald-700 text-sm hover:bg-emerald-50">Generar venta</Link>}
        <span className="flex-1" />
        <Link href="/ventas/cotizaciones" className="underline text-sm">← Cotizaciones</Link>
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] text-sm overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-white" style={{ background: v.estadoCotizacion === "cancelada" ? "var(--peligro)" : "var(--acento)" }}>
          <div className="text-lg font-semibold">Cotización - {folioDe(v)}</div>
          <div className="relative">
            <button className="px-3 py-1 rounded bg-white/15 hover:bg-white/25 text-sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Acciones ▾</button>
            {menu && (
              <ul role="menu" className="absolute right-0 mt-1 w-60 z-20 bg-[var(--panel)] text-[var(--texto)] border border-[var(--borde)] rounded shadow-lg py-1">
                {acciones.map((a) => (
                  <li key={a.texto}><button role="menuitem" disabled={a.deshabilitado || trabajando}
                    className={`w-full text-left px-3 py-1.5 hover:bg-[var(--resalte)] disabled:opacity-50 ${a.peligro ? "text-[var(--peligro)]" : ""}`}
                    onClick={() => { setMenu(false); a.fn?.(); }}>{a.texto}</button></li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="p-4 sm:p-6">
          <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <Dato k="Cliente">{v.cliente.razon_social || v.cliente.nombre}</Dato>
              <Dato k="Teléfono">{v.cliente.telefono ?? ""}</Dato>
              <Dato k="Capturó">{v.capturo ?? ""}</Dato>
              <Dato k="Comentarios">{v.comentarios ?? ""}</Dato>
            </div>
            <div>
              <Dato k="Fecha">{fechaMx(v.fecha)}</Dato>
              <Dato k="Vigencia">{v.vigencia ? new Date(`${v.vigencia}T12:00:00`).toLocaleDateString("es-MX") : ""}</Dato>
              <Dato k="Sucursal">{v.sucursal.codigo} - {v.sucursal.nombre}</Dato>
              <Dato k="Almacén">{v.almacen}</Dato>
            </div>
            <div>
              <div className="py-0.5"><span className="font-medium">Estatus:</span>{" "}
                <span className={`inline-block px-1.5 rounded text-xs ${est.cls}`} style={est.bg ? { background: est.bg } : undefined}>{est.txt}</span></div>
              {v.ventaId && <div className="py-0.5"><span className="font-medium">Venta:</span> <Link className="underline" href={`/ventas/${v.ventaId}`}>ver la venta</Link></div>}
              {v.estadoCotizacion === "cancelada" && v.motivo_cancelacion && <Dato k="Motivo de cancelación">{v.motivo_cancelacion}</Dato>}
            </div>
          </div>

          <div className="mt-5 text-[var(--tenue)]">Productos</div>
          <div className="overflow-x-auto mt-1">
            <table className="w-full min-w-[700px]">
              <thead style={{ color: "var(--acento)" }}>
                <tr className="text-left border-b border-[var(--borde)]">
                  <th className="py-1 pl-2 pr-3 font-normal">No</th><th className="pr-3 font-normal">Código</th><th className="pr-3 font-normal">Unidad</th>
                  <th className="pr-3 font-normal">Producto</th><th className="pr-3 font-normal text-right">Cant.</th><th className="pr-3 font-normal text-right">Precio</th>
                  <th className="pr-3 font-normal text-right">Descuento</th><th className="pr-2 font-normal text-right">Importe</th>
                </tr>
              </thead>
              <tbody>
                {v.partidas.map((p, i) => (
                  <tr key={p.renglon} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? "transparent" : "#f7f9fb" }}>
                    <td className="py-2 pl-2 pr-3">{p.renglon}</td><td className="py-2 pr-3 whitespace-nowrap">{p.sku}</td><td className="py-2 pr-3">{p.unidad}</td>
                    <td className="py-2 pr-3">{nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}
                      {p.unidad !== p.unidad_base && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(p.cantidad_base)} {p.unidad_base}</div>}
                      {p.comentario && <div className="text-xs italic">{p.comentario}</div>}</td>
                    <td className="py-2 pr-3 text-right">{fmtCantidad(p.cantidad)}</td><td className="py-2 pr-3 text-right">{fmtPrecio(p.precio_unitario)}</td>
                    <td className="py-2 pr-3 text-right">{fmtImporte(p.descuento)}</td><td className="py-2 pr-2 text-right">{fmtImporte(p.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-end mt-4">
            <dl className="grid grid-cols-[auto_auto] gap-x-10 gap-y-1 min-w-64">
              <dt>Subtotal:</dt><dd className="text-right">{fmtImporte(Number(v.subtotal) + Number(v.descuento))} MXN</dd>
              {Number(v.descuento) > 0 && <><dt>Descuento:</dt><dd className="text-right">−{fmtImporte(v.descuento)} MXN</dd></>}
              <dt>I.V.A.:</dt><dd className="text-right">{fmtImporte(v.iva)} MXN</dd>
              <dt className="font-semibold">Total:</dt><dd className="text-right font-semibold">{fmtImporte(v.total)} MXN</dd>
            </dl>
          </div>
        </div>
      </section>

      {cancelacion && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setCancelacion(null)}>
          <div role="dialog" aria-label="Cancelar cotización" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Cancelar cotización {folioDe(v)}</h2>
            <label className="block mt-3">Motivo
              <select className="campo" value={cancelacion.motivo} onChange={(e) => setCancelacion({ ...cancelacion, motivo: e.target.value })}>
                <option value="">— Elige —</option>{MOTIVOS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </label>
            <label className="block mt-3">Detalle {cancelacion.motivo === "Otro" ? "*" : "(opcional)"}
              <textarea className="campo h-16" value={cancelacion.detalle} onChange={(e) => setCancelacion({ ...cancelacion, detalle: e.target.value })} />
            </label>
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setCancelacion(null)}>Cerrar</button>
              <button className="px-4 py-2 rounded text-white disabled:opacity-50" style={{ background: "var(--peligro)" }} disabled={trabajando || !cancelacion.motivo}
                onClick={confirmarCancelacion}>{trabajando ? "Cancelando…" : "Cancelar cotización"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
