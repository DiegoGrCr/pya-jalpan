"use client";
/**
 * Ventas › Detalle de una venta guardada.
 * Al guardar se llega aquí. Acomodo como en las notas: barra con el folio y "Acciones"
 * (imprimir carta o ticket, PDF, correo, WhatsApp, compartir, facturar, cancelar), pestañas
 * Detalle / Pagos, datos en tres columnas, productos y totales.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, fmtPrecio, mxn, nombreConCaja } from "@/lib/unidades";
import { copiarImagen, pdfAPng } from "@/lib/notaImagen";
import { FORMAS_PAGO, VentaDoc, cargarVenta, fechaMx, folioDe, generarPdf, pendienteEntrega, resumenTexto, tituloDe } from "@/lib/documentoVenta";

type Formato = "carta" | "ticket80" | "ticket58";
const CLAVE_TICKET = "formato-ticket";

export default function DetalleVenta() {
  const { id } = useParams<{ id: string }>();

  const [v, setV] = useState<VentaDoc | null>(null);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [ticket, setTicket] = useState<"ticket80" | "ticket58">("ticket80");
  const [menu, setMenu] = useState(false);
  const [pestana, setPestana] = useState<"detalle" | "pagos">("detalle");

  // Cierra el menú de acciones al hacer clic fuera
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[aria-haspopup='menu'], [role='menu']")) setMenu(false); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [menu]);

  const recargar = useCallback(async () => {
    try { setV(await cargarVenta(id)); } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [id]);

  useEffect(() => { recargar(); }, [recargar]);
  // Los avisos de éxito desaparecen solos
  useEffect(() => {
    if (msg?.tipo !== "ok") return;
    const t = setTimeout(() => setMsg(null), /Cambio|Ctrl\+V/.test(msg.texto) ? 10000 : 3500); // el cambio se deja más tiempo a la vista
    return () => clearTimeout(t);
  }, [msg]);
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

  /**
   * WhatsApp con la nota:
   * - Celular: menú para compartir del equipo con el PDF adjunto (eliges WhatsApp y el contacto).
   * - Computadora: la nota se copia como imagen y se abre el chat del cliente; se pega con Ctrl+V.
   */
  const whatsapp = async () => {
    if (!v) return;
    const tel = (v.cliente.telefono ?? "").replace(/\D/g, "");
    const num = tel.length === 10 ? `52${tel}` : tel;
    const movil = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) && typeof navigator.canShare === "function";
    setTrabajando(true);
    try {
      const pdf = await generarPdf(v, "carta");
      if (movil) {
        const archivo = new File([pdf], nombreArchivo("carta"), { type: "application/pdf" });
        if (navigator.canShare({ files: [archivo] })) { await navigator.share({ files: [archivo], title: tituloDe(v) }); return; }
      }
      const copiada = await copiarImagen(await pdfAPng(pdf));
      const abierta = window.open(`https://wa.me/${num}`, "_blank");
      if (abierta) abierta.opener = null;
      setMsg(copiada
        ? { tipo: "ok", texto: `Nota copiada como imagen. En el chat de WhatsApp presiona Ctrl+V y envía.${abierta ? "" : " (Abre WhatsApp tú: el navegador bloqueó la ventana.)"}` }
        : { tipo: "error", texto: "Este navegador no permite copiar la imagen. Usa Acciones › Descargar imagen y adjúntala en WhatsApp." });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsg({ tipo: "error", texto: mensajeError(e) });
    } finally { setTrabajando(false); }
  };

  /** Copia la nota como imagen o la descarga como PNG. */
  const imagen = async (modo: "copiar" | "descargar") => {
    if (!v) return;
    setTrabajando(true);
    try {
      const png = await pdfAPng(await generarPdf(v, "carta"));
      if (modo === "copiar") {
        setMsg(await copiarImagen(png)
          ? { tipo: "ok", texto: "Nota copiada como imagen. Pégala con Ctrl+V donde la necesites." }
          : { tipo: "error", texto: "Este navegador no permite copiar imágenes. Usa Descargar imagen." });
      } else {
        const url = URL.createObjectURL(png);
        Object.assign(document.createElement("a"), { href: url, download: `${folioDe(v)}.png` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
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
  const formasPago = [...new Set(v.pagos.map((p) => FORMAS_PAGO[p.forma] ?? p.forma))].join(", ");
  const acciones: { texto: string; fn?: () => void; deshabilitado?: boolean; peligro?: boolean; nota?: string }[] = [
    { texto: "Imprimir ticket", fn: () => imprimir(ticket) },
    { texto: "Imprimir carta", fn: () => imprimir("carta") },
    { texto: "Descargar PDF", fn: () => descargar("carta") },
    { texto: "Descargar PDF ticket", fn: () => descargar(ticket) },
    { texto: "Enviar por correo", fn: correo },
    { texto: "Enviar por WhatsApp", fn: whatsapp },
    { texto: "Copiar nota como imagen", fn: () => imagen("copiar") },
    { texto: "Descargar imagen (PNG)", fn: () => imagen("descargar") },
    { texto: "Compartir", fn: compartir },
    { texto: "Emitir factura (CFDI)", deshabilitado: true, nota: "Disponible cuando se configure la facturación" },
    ...(!cancelada ? [{ texto: "Cancelar venta", fn: cancelar, deshabilitado: !!v.factura_uuid, peligro: true }] : []),
  ];
  const Dato = ({ k, children }: { k: string; children: React.ReactNode }) => (
    <div className="py-0.5"><span className="font-medium">{k}:</span> <span className="text-[var(--tenue)]">{children}</span></div>
  );

  return (
    <div className="p-3 sm:p-5">
      {msg && (
        msg.tipo === "ok"
          // Aviso discreto: esquina inferior derecha y se quita solo
          ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-md px-4 py-2 text-sm shadow-lg bg-emerald-600 text-white">✓ {msg.texto}</div>
          : <div role="alert" className="mb-3 rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>
      )}

      {/* Accesos rápidos */}
      <div className="flex flex-wrap gap-2 mb-3 items-center">
        <Link href="/ventas/capturar" className="btn-primario" title="F2">Nueva venta</Link>
        <button className={btn} disabled={trabajando} onClick={() => imprimir(ticket)} title="Ctrl+P">Imprimir ticket</button>
        <select aria-label="Ancho del ticket" className="campo !w-auto text-sm" value={ticket} onChange={(e) => {
          const t = e.target.value as "ticket80" | "ticket58"; setTicket(t); try { localStorage.setItem(CLAVE_TICKET, t); } catch { /* ignorar */ }
        }}>
          <option value="ticket80">80 mm</option><option value="ticket58">58 mm</option>
        </select>
        <span className="flex-1" />
        <Link href="/ventas/lista" className="underline text-sm">← Lista de ventas</Link>
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] text-sm overflow-hidden">
        {/* Barra de título con acciones */}
        <div className="flex items-center justify-between gap-3 px-4 py-2 text-white" style={{ background: cancelada ? "var(--peligro)" : "var(--acento)" }}>
          <div className="text-lg font-semibold">{tituloDe(v).replace(/ (\S+)$/, " - $1")}</div>
          <div className="relative">
            <button className="px-3 py-1 rounded bg-white/15 hover:bg-white/25 text-sm" aria-haspopup="menu" aria-expanded={menu}
              onClick={() => setMenu(!menu)}>Acciones ▾</button>
            {menu && (
              <ul role="menu" className="absolute right-0 mt-1 w-60 z-20 bg-[var(--panel)] text-[var(--texto)] border border-[var(--borde)] rounded shadow-lg py-1">
                {acciones.map((a) => (
                  <li key={a.texto}>
                    <button role="menuitem" disabled={a.deshabilitado || trabajando} title={a.nota}
                      className={`w-full text-left px-3 py-1.5 hover:bg-[var(--resalte)] disabled:opacity-50 ${a.peligro ? "text-[var(--peligro)]" : ""}`}
                      onClick={() => { setMenu(false); a.fn?.(); }}>{a.texto}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Pestañas */}
        <div className="flex gap-1 border-b border-[var(--borde)] px-4 pt-2">
          {(["detalle", "pagos"] as const).map((t) => (
            <button key={t} onClick={() => setPestana(t)}
              className={`px-3 py-1.5 rounded-t border border-b-0 ${pestana === t ? "border-[var(--borde)] bg-[var(--panel)] font-semibold" : "border-transparent text-[var(--acento)]"}`}>
              {t === "detalle" ? "Detalle" : <>Pagos <span className="ml-1 px-1.5 rounded-full text-xs text-white" style={{ background: "var(--acento)" }}>{v.pagos.length}</span></>}
            </button>
          ))}
        </div>

        <div className="p-4 sm:p-6">
          {pestana === "detalle" ? (
            <>
              <div className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <Dato k="Cliente">{v.cliente.razon_social || v.cliente.nombre}</Dato>
                  <Dato k="Teléfono">{v.cliente.telefono ?? ""}</Dato>
                  <Dato k="Capturó">{v.capturo ?? ""}</Dato>
                  <Dato k="Forma de pago">{formasPago || (v.tipo === "credito" ? "Crédito" : "")}</Dato>
                  <Dato k="Comentarios">{v.comentarios ?? ""}</Dato>
                </div>
                <div>
                  <Dato k="Tipo">{v.tipo === "credito" ? "Crédito" : "Contado"}</Dato>
                  <Dato k="Fecha">{fechaMx(v.fecha)}</Dato>
                  <Dato k="Sucursal">{v.sucursal.codigo} - {v.sucursal.nombre}</Dato>
                  <Dato k="Almacén">{v.almacen}</Dato>
                </div>
                <div>
                  <div className="py-0.5"><span className="font-medium">Estatus:</span>{" "}
                    {cancelada
                      ? <span className="px-1.5 rounded text-xs text-white" style={{ background: "var(--peligro)" }}>Cancelada</span>
                      : <span className="px-1.5 rounded text-xs bg-emerald-100 text-emerald-900">Activa</span>}
                    {!cancelada && pendienteEntrega(v) && <span className="ml-1 px-1.5 rounded text-xs bg-amber-100 text-amber-900">Entrega pendiente</span>}
                    {v.factura_uuid && <span className="ml-1 px-1.5 rounded text-xs bg-sky-100 text-sky-900">Facturada</span>}
                  </div>
                  <Dato k="RFC">{v.cliente.rfc ?? ""}</Dato>
                  <Dato k="Vencimiento">{v.vencimiento ?? ""}</Dato>
                  <Dato k="Orden de compra">{v.orden_compra ?? ""}</Dato>
                  {cancelada && v.motivo_cancelacion && <Dato k="Motivo de cancelación">{v.motivo_cancelacion}</Dato>}
                </div>
              </div>

              <div className="mt-5 text-[var(--tenue)]">Productos</div>
              <div className="overflow-x-auto mt-1">
                <table className="w-full min-w-[760px]">
                  <thead style={{ color: "var(--acento)" }}>
                    <tr className="text-left border-b border-[var(--borde)]">
                      <th className="py-1 pl-2 pr-3 font-normal">No</th><th className="pr-3 font-normal">Código</th><th className="pr-3 font-normal">Unidad</th>
                      <th className="pr-3 font-normal">Producto</th><th className="pr-3 font-normal text-right">Cant.</th><th className="pr-3 font-normal text-right">Entregado</th>
                      <th className="pr-3 font-normal text-right">Precio</th><th className="pr-3 font-normal text-right">Descuento</th><th className="pr-2 font-normal text-right">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.partidas.map((p, i) => (
                      <tr key={p.renglon} className="border-b border-[var(--borde)] align-top" style={{ background: i % 2 ? "transparent" : "#f7f9fb" }}>
                        <td className="py-2 pl-2 pr-3">{p.renglon}</td>
                        <td className="py-2 pr-3 whitespace-nowrap">{p.sku}</td>
                        <td className="py-2 pr-3">{p.unidad}</td>
                        <td className="py-2 pr-3">{nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}
                          {p.unidad !== p.unidad_base && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(p.cantidad_base)} {p.unidad_base}</div>}
                          {p.comentario && <div className="text-xs italic">{p.comentario}</div>}
                          {p.vendida_sin_existencia && <div className="text-xs text-[var(--peligro)]">Vendida sin existencia suficiente</div>}
                        </td>
                        <td className="py-2 pr-3 text-right">{fmtCantidad(p.cantidad)}</td>
                        <td className={`py-2 pr-3 text-right ${Number(p.cantidad_entregada) < Number(p.cantidad) && !cancelada ? "text-amber-700 font-semibold" : ""}`}>{fmtCantidad(p.cantidad_entregada)}</td>
                        <td className="py-2 pr-3 text-right">{fmtPrecio(p.precio_unitario)}</td>
                        <td className="py-2 pr-3 text-right">{fmtImporte(p.descuento)}</td>
                        <td className="py-2 pr-2 text-right">{fmtImporte(p.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <table className="w-full max-w-2xl">
              <thead style={{ color: "var(--acento)" }}>
                <tr className="text-left border-b border-[var(--borde)]"><th className="py-1 font-normal">Forma de pago</th><th className="font-normal">Referencia</th><th className="font-normal text-right">Importe</th></tr>
              </thead>
              <tbody>
                {v.pagos.length ? v.pagos.map((p, i) => (
                  <tr key={i} className="border-b border-[var(--borde)]">
                    <td className="py-1.5">{FORMAS_PAGO[p.forma] ?? p.forma}</td><td>{p.referencia ?? ""}</td><td className="text-right">{fmtImporte(p.importe)}</td>
                  </tr>
                )) : <tr><td colSpan={3} className="py-3 text-[var(--tenue)]">Sin pagos registrados{v.tipo === "credito" ? " (venta a crédito)" : ""}.</td></tr>}
              </tbody>
            </table>
          )}

          {/* Totales */}
          <div className="flex justify-end mt-4">
            <dl className="grid grid-cols-[auto_auto] gap-x-10 gap-y-1 min-w-64">
              <dt>Subtotal:</dt><dd className="text-right">{fmtImporte(Number(v.subtotal) + Number(v.descuento))} MXN</dd>
              {Number(v.descuento) > 0 && <><dt>Descuento:</dt><dd className="text-right">−{fmtImporte(v.descuento)} MXN</dd></>}
              {Number(v.ieps) > 0 && <><dt>I.E.P.S.:</dt><dd className="text-right">{fmtImporte(v.ieps)} MXN</dd></>}
              <dt>I.V.A.:</dt><dd className="text-right">{fmtImporte(v.iva)} MXN</dd>
              <dt className="font-semibold">Total:</dt><dd className="text-right font-semibold">{fmtImporte(v.total)} MXN</dd>
              <dt className="mt-2">Pagado:</dt><dd className="text-right mt-2">{fmtImporte(v.pagado)} MXN</dd>
              {v.tipo === "credito"
                ? <><dt>Saldo:</dt><dd className="text-right font-semibold">{fmtImporte(v.saldo)} MXN</dd></>
                : <><dt>Cambio:</dt><dd className="text-right">{fmtImporte(v.cambio)} MXN</dd></>}
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}
