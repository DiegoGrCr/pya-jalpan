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
import { fmtCantidad, fmtImporte, fmtPrecio, mxn, nombreConCaja, tipoVentaDe } from "@/lib/unidades";
import { copiarImagen, pdfAPng } from "@/lib/notaImagen";
import EstatusVenta from "@/components/EstatusVenta";
import { FORMAS_PAGO, VentaDoc, archivoDe, cargarVenta, fechaMx, folioDe, generarPdf, pendienteEntrega, resumenTexto, tituloDe } from "@/lib/documentoVenta";
import { EsqueletoFicha } from "@/components/Esqueleto";

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
  const [pestana, setPestana] = useState<"detalle" | "pagos" | "actividades">("detalle");
  // Estado de cierre y ediciones (0027); si falta la migración se asume abierta y sin edición
  const [cierre, setCierre] = useState<{ cerrada: boolean; ediciones: number; disponible: boolean; conAbono?: boolean }>({ cerrada: false, ediciones: 0, disponible: false });
  const [historial, setHistorial] = useState<{ fecha: string; accion: string; usuario: string; detalle: Record<string, unknown> }[] | null>(null);
  const [devoluciones, setDevoluciones] = useState<{ fecha: string; forma: string; importe: string }[]>([]);
  // Devolución de productos (0038)
  type DevProd = { id: string; fecha: string; destino: string; forma: string | null; importe: string; motivo: string; partidas: { producto: string; unidad: string; cantidad: number; importe: number }[] };
  const [devProd, setDevProd] = useState<DevProd[] | null>(null);
  const [renglones, setRenglones] = useState<{ id: string; renglon: number; cantidad_entregada: number; cantidad_devuelta: number }[]>([]);
  const [devolucion, setDevolucion] = useState<{ clave: string; cantidades: Record<string, string>; motivo: string; detalle: string; destino: "saldo_favor" | "dinero"; forma: string } | null>(null);
  const [cancelacion, setCancelacion] = useState<{ motivo: string; detalle: string } | null>(null);
  const [pago, setPago] = useState<{ clave: string; forma: string; importe: string; referencia: string; comentarios: string } | null>(null);

  // Cierra el menú de acciones al hacer clic fuera
  useEffect(() => {
    if (!menu) return;
    const h = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest("[aria-haspopup='menu'], [role='menu']")) setMenu(false); };
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [menu]);

  const recargar = useCallback(async () => {
    try {
      setV(await cargarVenta(id));
      const sb = supabase();
      const [ex, dv, dp, rg] = await Promise.all([
        sb.from("ventas").select("cerrada, ediciones, con_abono").eq("id", id).maybeSingle(),
        sb.from("venta_devoluciones").select("fecha, forma, importe").eq("venta_id", id).order("fecha"),
        sb.from("devoluciones_producto").select("id, fecha, destino, forma, importe, motivo, partidas").eq("venta_id", id).order("fecha"),
        sb.from("venta_partidas").select("id, renglon, cantidad_entregada, cantidad_devuelta").eq("venta_id", id),
      ]);
      setDevProd(dp.error ? null : (dp.data ?? []) as DevProd[]);
      setRenglones(rg.error ? [] : ((rg.data ?? []) as { id: string; renglon: number; cantidad_entregada: string; cantidad_devuelta: string }[])
        .map((x) => ({ id: x.id, renglon: x.renglon, cantidad_entregada: Number(x.cantidad_entregada), cantidad_devuelta: Number(x.cantidad_devuelta) })));
      const d = ex.data as { cerrada: boolean; ediciones: number; con_abono: boolean } | null;
      setCierre(ex.error || !d ? { cerrada: false, ediciones: 0, disponible: false } : { cerrada: d.cerrada, ediciones: d.ediciones, conAbono: d.con_abono, disponible: true });
      setDevoluciones(dv.error ? [] : (dv.data ?? []) as { fecha: string; forma: string; importe: string }[]);
      setHistorial(null);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [id]);

  const guardarDevolucion = async () => {
    if (!v || !devolucion) return;
    const motivo = [devolucion.motivo, devolucion.detalle.trim()].filter(Boolean).join(": ");
    if (!devolucion.motivo || (devolucion.motivo === "Otro" && !devolucion.detalle.trim())) { setMsg({ tipo: "error", texto: "Indica el motivo de la devolución." }); return; }
    setTrabajando(true);
    try {
      const partidas = Object.entries(devolucion.cantidades).filter(([, c]) => Number(c) > 0).map(([partida_id, cantidad]) => ({ partida_id, cantidad }));
      const { data, error } = await supabase().rpc("devolver_productos", { p: { idempotency_key: devolucion.clave, venta_id: v.id, motivo,
        destino: devolucion.destino, forma: devolucion.destino === "dinero" ? devolucion.forma : null, partidas } });
      if (error) {
        if (/devolver_productos/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000038_cartera_devoluciones.sql en Supabase.");
        throw error;
      }
      setDevolucion(null);
      setMsg({ tipo: "ok", texto: `Devolución registrada por ${mxn(data.importe)}${devolucion.destino === "saldo_favor" ? " a favor del cliente" : ""}.` });
      await recargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const cargarHistorial = async () => {
    const { data, error } = await supabase().rpc("historial_venta", { p_venta: id });
    setHistorial(error ? [] : (data ?? []) as { fecha: string; accion: string; usuario: string; detalle: Record<string, unknown> }[]);
  };

  const cerrarVenta = async () => {
    if (!v || !window.confirm(`¿Cerrar la venta ${folioDe(v)}? Ya no se podrá editar (solo cancelar).`)) return;
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cerrar_venta", { p_venta: v.id });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `Venta ${folioDe(v)} cerrada.` });
      await recargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

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
    if (params.get("editada")) setMsg({ tipo: "ok", texto: "Cambios guardados." });
    if (params.get("nueva")) setMsg({ tipo: "ok", texto: `Venta guardada.${cambio && Number(cambio) > 0 ? ` Cambio: ${mxn(cambio)}.` : ""}` });
  }, []);

  const nombreArchivo = (f: Formato) => `${v ? archivoDe(v) : "Remision"}${f === "carta" ? "" : "_ticket"}.pdf`;

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
        Object.assign(document.createElement("a"), { href: url, download: `${archivoDe(v)}.png` }).click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const MOTIVOS = ["Error en la captura", "El cliente ya no la quiere", "Devolución de material", "Se capturó dos veces", "Otro"];
  const confirmarCancelacion = async () => {
    if (!v || !cancelacion) return;
    const motivo = [cancelacion.motivo, cancelacion.detalle.trim()].filter(Boolean).join(": ");
    if (!cancelacion.motivo || (cancelacion.motivo === "Otro" && !cancelacion.detalle.trim())) { setMsg({ tipo: "error", texto: "Indica el motivo de la cancelación." }); return; }
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cancelar_venta", { p_venta: v.id, p_motivo: motivo });
      if (error) throw error;
      setCancelacion(null);
      setMsg({ tipo: "ok", texto: `Venta ${folioDe(v)} cancelada.` });
      await recargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const guardarPago = async () => {
    if (!v || !pago) return;
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("registrar_pago_venta", { p: {
        idempotency_key: pago.clave, venta_id: v.id, forma: pago.forma, importe: pago.importe,
        referencia: pago.referencia || null, comentarios: pago.comentarios || null,
      } });
      if (error) {
        if (/registrar_pago_venta/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000023_registrar_pago.sql en Supabase.");
        throw error;
      }
      setPago(null);
      setMsg({ tipo: "ok", texto: `Pago de ${mxn(pago.importe)} registrado.` });
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

  if (cargando) return <EsqueletoFicha />;
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
    ...(!cancelada && !cierre.cerrada ? [
      { texto: "Editar venta", fn: () => { window.location.href = `/ventas/capturar?editar=${v.id}`; }, deshabilitado: !cierre.disponible || !!v.factura_uuid,
        nota: cierre.disponible ? undefined : "Falta ejecutar la migración 20261118000027_ventas_editables.sql" },
      { texto: "Cerrar venta", fn: cerrarVenta, deshabilitado: !cierre.disponible },
    ] : []),
    ...(!cancelada && devProd !== null ? [{ texto: "Devolver productos", fn: () => setDevolucion({ clave: crypto.randomUUID(), cantidades: {}, motivo: "", detalle: "",
        destino: v.cliente.es_publico_general ? "dinero" as const : "saldo_favor" as const, forma: "efectivo" }),
      deshabilitado: !renglones.some((r) => r.cantidad_entregada - r.cantidad_devuelta > 0), nota: "Solo se devuelve material ya entregado" }] : []),
    { texto: "Registrar pago", fn: () => setPago({ clave: crypto.randomUUID(), forma: "efectivo", importe: Number(v.saldo).toFixed(2), referencia: "", comentarios: "" }),
      deshabilitado: cancelada || !(Number(v.saldo) > 0), nota: Number(v.saldo) > 0 ? undefined : "La venta no tiene saldo pendiente" },
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
    ...(!cancelada ? [{ texto: "Cancelar venta", fn: () => setCancelacion({ motivo: "", detalle: "" }), deshabilitado: !!v.factura_uuid, peligro: true }] : []),
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
          {(["detalle", "pagos", "actividades"] as const).map((t) => (
            <button key={t} onClick={() => { setPestana(t); if (t === "actividades" && historial === null) cargarHistorial(); }}
              className={`px-3 py-1.5 rounded-t border border-b-0 ${pestana === t ? "border-[var(--borde)] bg-[var(--panel)] font-semibold" : "border-transparent text-[var(--acento)]"}`}>
              {t === "detalle" ? "Detalle" : t === "actividades" ? "Actividades" : <>Pagos <span className="ml-1 px-1.5 rounded-full text-xs text-white" style={{ background: "var(--acento)" }}>{v.pagos.length}</span></>}
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
                  <Dato k="Tipo de venta">{tipoVentaDe(v.tipo, cierre.conAbono).largo}</Dato>
                  <Dato k="Fecha">{fechaMx(v.fecha)}</Dato>
                  <Dato k="Sucursal">{v.sucursal.codigo} - {v.sucursal.nombre}</Dato>
                  <Dato k="Almacén">{v.almacen}</Dato>
                </div>
                <div>
                  <div className="py-0.5"><span className="font-medium">Estatus:</span>{" "}
                    <EstatusVenta estado={v.estado} saldo={v.saldo} cerrada={cierre.disponible ? cierre.cerrada : null} porEntregar={!cancelada && pendienteEntrega(v)} />
                    {cierre.ediciones > 0 && <span className="ml-1 px-1.5 rounded text-xs bg-sky-100 text-sky-900">Editada {cierre.ediciones}×</span>}
                    {v.factura_uuid && <span className="ml-1 px-1.5 rounded text-xs bg-sky-100 text-sky-900">Facturada</span>}
                  </div>
                  <Dato k="RFC">{v.cliente.rfc ?? ""}</Dato>
                  <Dato k="Vencimiento">{v.vencimiento ?? ""}</Dato>
                  <Dato k="Orden de compra">{v.orden_compra ?? ""}</Dato>
                  {cancelada && v.motivo_cancelacion && <Dato k="Motivo de cancelación">{v.motivo_cancelacion}</Dato>}
                </div>
              </div>

              {devProd && devProd.length > 0 && (
                <div className="mt-4 rounded border border-orange-200 bg-orange-50 px-3 py-2">
                  <div className="font-medium text-orange-900">Devoluciones de producto</div>
                  <ul className="mt-1 flex flex-col gap-1">
                    {devProd.map((d) => (
                      <li key={d.id}>
                        <span className="text-[var(--tenue)]">{fechaMx(d.fecha)}</span> · {d.partidas.map((x) => `${fmtCantidad(x.cantidad)} ${x.unidad} ${x.producto}`).join(", ")}
                        {" "}· <b>{mxn(d.importe)}</b> {d.destino === "saldo_favor" ? "a favor del cliente" : `devueltos (${FORMAS_PAGO[d.forma ?? ""] ?? d.forma})`} · {d.motivo}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
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
                          {p.almacen && <div className={`text-xs ${p.almacen !== v.almacen ? "font-semibold" : ""}`} style={{ color: "var(--acento)" }}>Sale de: {p.almacen}</div>}
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
          ) : pestana === "actividades" ? (
            <div className="max-w-3xl">
              {historial === null ? <div className="text-[var(--tenue)]">Cargando…</div>
                : !historial.length ? <div className="text-[var(--tenue)]">Sin actividades registradas (o falta la migración 0027).</div>
                : <ul className="flex flex-col gap-2">
                    {historial.map((h, i) => {
                      const d = h.detalle as { total?: string; exceso?: string; diferencia?: string; motivo?: string; forma?: string; importe?: string; antes?: { total?: string } };
                      const texto = h.accion === "editar" ? `Editó la venta: total ${mxn(d.antes?.total ?? 0)} → ${mxn(d.total ?? 0)}${Number(d.exceso) > 0 ? ` · diferencia de ${mxn(d.exceso!)} ${d.diferencia === "saldo_favor" ? "dejada a favor del cliente" : "devuelta"}` : ""}`
                        : h.accion === "cerrar" ? "Cerró la venta"
                        : h.accion === "devolucion" ? `Registró una devolución de ${mxn(d.importe ?? 0)} (${d.motivo ?? ""})`
                        : h.accion === "cancelar" ? `Canceló la venta${d.motivo ? `: ${d.motivo}` : ""}`
                        : h.accion === "pago" ? `Registró un pago de ${mxn(d.importe ?? 0)} (${FORMAS_PAGO[d.forma ?? ""] ?? d.forma})`
                        : h.accion === "insert" || h.accion === "crear" ? "Creó la venta" : h.accion;
                      return <li key={i} className="border-b border-[var(--borde)] pb-2"><span className="text-[var(--tenue)]">{fechaMx(h.fecha)} · {h.usuario || "—"}</span><div>{texto}</div></li>;
                    })}
                  </ul>}
            </div>
          ) : (
            <table className="w-full max-w-2xl">
              <thead style={{ color: "var(--acento)" }}>
                <tr className="text-left border-b border-[var(--borde)]"><th className="py-1 font-normal">Fecha</th><th className="font-normal">Forma de pago</th><th className="font-normal">Referencia</th><th className="font-normal text-right">Importe</th></tr>
              </thead>
              <tbody>
                {v.pagos.length ? v.pagos.map((p, i) => (
                  <tr key={i} className="border-b border-[var(--borde)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{p.fecha ? fechaMx(p.fecha) : ""}</td><td className="pr-3">{FORMAS_PAGO[p.forma] ?? p.forma}</td><td className="pr-3">{p.referencia ?? ""}</td><td className="text-right">{fmtImporte(p.importe)}</td>
                  </tr>
                )) : null}
                {devoluciones.map((d, i) => (
                  <tr key={`d${i}`} className="border-b border-[var(--borde)] text-[var(--peligro)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fechaMx(d.fecha)}</td><td className="pr-3">Devolución · {FORMAS_PAGO[d.forma] ?? d.forma}</td><td className="pr-3">Por edición de la venta</td><td className="text-right">−{fmtImporte(d.importe)}</td>
                  </tr>
                ))}
                {!v.pagos.length && !devoluciones.length ? <tr><td colSpan={4} className="py-3 text-[var(--tenue)]">Sin pagos registrados{v.tipo === "credito" ? " (venta a crédito)" : ""}.</td></tr> : null}
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
              {v.tipo === "credito" || Number(v.saldo) > 0
                ? <><dt>Saldo:</dt><dd className="text-right font-semibold">{fmtImporte(v.saldo)} MXN</dd></>
                : <><dt>Cambio:</dt><dd className="text-right">{fmtImporte(v.cambio)} MXN</dd></>}
            </dl>
          </div>
        </div>
      </section>
      {devolucion && (
        <Ventana titulo={`Devolver productos de ${folioDe(v)}`} onCerrar={() => setDevolucion(null)}>
          <p className="text-xs text-[var(--tenue)] mb-2">El material regresa al inventario de la bodega de donde salió. Solo se puede devolver lo ya entregado.</p>
          <table className="w-full text-sm">
            <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
              <th className="font-normal py-1">Producto</th><th className="font-normal text-right">Puede devolver</th><th className="font-normal text-right w-28">Devuelve</th></tr></thead>
            <tbody>
              {v.partidas.map((p) => {
                const r = renglones.find((x) => x.renglon === p.renglon);
                const max = r ? r.cantidad_entregada - r.cantidad_devuelta : 0;
                if (!r || max <= 0) return null;
                return (
                  <tr key={r.id} className="border-b border-[var(--borde)]">
                    <td className="py-1.5 pr-2">{nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}</td>
                    <td className="text-right pr-2 whitespace-nowrap">{fmtCantidad(max)} {p.unidad}</td>
                    <td className="py-1"><input className="campo !py-1 text-right" inputMode="decimal" placeholder="0" value={devolucion.cantidades[r.id] ?? ""}
                      onChange={(e) => setDevolucion({ ...devolucion, cantidades: { ...devolucion.cantidades, [r.id]: e.target.value } })} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {(() => {
            const total = v.partidas.reduce((s, p) => {
              const r = renglones.find((x) => x.renglon === p.renglon);
              const c = r ? Number(devolucion.cantidades[r.id] || 0) : 0;
              return s + (c > 0 ? Math.round(Number(p.total) * c / Number(p.cantidad) * 100) / 100 : 0);
            }, 0);
            return <div className="text-right mt-2">Importe a devolver: <b>{mxn(total)}</b></div>;
          })()}
          <label className="block mt-3">Motivo
            <select className="campo" value={devolucion.motivo} onChange={(e) => setDevolucion({ ...devolucion, motivo: e.target.value })}>
              <option value="">— Elige —</option>
              {["Le sobró material", "Material dañado o defectuoso", "Se equivocó de modelo o tono", "Otro"].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="block mt-2">Detalle {devolucion.motivo === "Otro" ? "*" : "(opcional)"}
            <input className="campo" value={devolucion.detalle} onChange={(e) => setDevolucion({ ...devolucion, detalle: e.target.value })} />
          </label>
          <div className="mt-3 flex flex-col gap-1">
            <label className={`flex items-center gap-2 ${v.cliente.es_publico_general ? "opacity-50" : ""}`}>
              <input type="radio" disabled={v.cliente.es_publico_general} checked={devolucion.destino === "saldo_favor"} onChange={() => setDevolucion({ ...devolucion, destino: "saldo_favor" })} />
              Dejarlo como saldo a favor del cliente {v.cliente.es_publico_general && <span className="text-xs">(no aplica a Público en general)</span>}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={devolucion.destino === "dinero"} onChange={() => setDevolucion({ ...devolucion, destino: "dinero" })} /> Devolverle el dinero
              {devolucion.destino === "dinero" && (
                <select className="campo !py-1 !w-auto" value={devolucion.forma} onChange={(e) => setDevolucion({ ...devolucion, forma: e.target.value })}>
                  <option value="efectivo">en efectivo</option><option value="transferencia">por transferencia</option>
                  <option value="tarjeta_debito">a tarjeta de débito</option><option value="tarjeta_credito">a tarjeta de crédito</option>
                </select>
              )}
            </label>
          </div>
          <p className="text-xs text-amber-800 mt-3">Al registrar la devolución la venta queda cerrada y ya no se podrá cancelar.</p>
          <div className="flex justify-end gap-3 mt-4">
            <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setDevolucion(null)}>Cerrar</button>
            <button className="btn-primario" disabled={trabajando || !devolucion.motivo || !Object.values(devolucion.cantidades).some((c) => Number(c) > 0)}
              onClick={guardarDevolucion}>{trabajando ? "Guardando…" : "Registrar devolución"}</button>
          </div>
        </Ventana>
      )}

      {pago && (
        <Ventana titulo="Registrar pago" onCerrar={() => setPago(null)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>Forma de pago
              <select className="campo" value={pago.forma} onChange={(e) => setPago({ ...pago, forma: e.target.value })}>
                <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option>
                <option value="tarjeta_debito">Tarjeta de débito</option><option value="tarjeta_credito">Tarjeta de crédito</option>
              </select>
            </label>
            <label>Referencia
              <input className="campo" placeholder="Folio de transferencia, últimos 4 dígitos…" value={pago.referencia} onChange={(e) => setPago({ ...pago, referencia: e.target.value })} />
            </label>
            <label>Importe (MXN)
              <input className="campo" inputMode="decimal" value={pago.importe} onChange={(e) => setPago({ ...pago, importe: e.target.value })} />
              <span className="text-xs text-[var(--tenue)]">Saldo pendiente: {mxn(v.saldo)}</span>
            </label>
            <label>Fecha
              <input className="campo" readOnly value={new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" })} />
            </label>
            <label className="sm:col-span-2">Comentarios
              <textarea className="campo h-16" value={pago.comentarios} onChange={(e) => setPago({ ...pago, comentarios: e.target.value })} />
            </label>
          </div>
          <div className="flex justify-end gap-3 mt-4">
            <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setPago(null)}>Cancelar</button>
            <button className="btn-primario" disabled={trabajando || !(Number(pago.importe) > 0)} onClick={guardarPago}>{trabajando ? "Guardando…" : "Guardar"}</button>
          </div>
        </Ventana>
      )}

      {cancelacion && (
        <Ventana titulo={`Cancelar venta ${folioDe(v)}`} onCerrar={() => setCancelacion(null)}>
          <p className="rounded px-3 py-2 bg-amber-50 text-amber-900">
            El material regresa al inventario del almacén y la venta queda cancelada con sus pagos. Esta acción no se puede deshacer.
          </p>
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
            <button className="px-4 py-2 rounded text-white disabled:opacity-50" style={{ background: "var(--peligro)" }}
              disabled={trabajando || !cancelacion.motivo} onClick={confirmarCancelacion}>{trabajando ? "Cancelando…" : "Cancelar venta"}</button>
          </div>
        </Ventana>
      )}
    </div>
  );
}

/** Ventana modal sencilla (fondo oscuro, se cierra con la X o el fondo). */
function Ventana({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={onCerrar}>
      <div role="dialog" aria-label={titulo} className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-xl p-5 text-sm" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-lg font-semibold">{titulo}</h2>
          <button aria-label="Cerrar" className="text-[var(--peligro)] text-lg" onClick={onCerrar}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
