"use client";
/**
 * Configuración › Empresa y documentos
 * Datos que aparecen en la remisión: emisor, RFC, teléfono, logotipos (hasta 6), condiciones generales,
 * y por sucursal: dirección, C.P., teléfono y lugar de expedición. Incluye vista previa del PDF.
 */
import { useCallback, useEffect, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { EMPRESA_VACIA, EmpresaDoc, VentaDoc, cargarEmpresa, generarPdf } from "@/lib/documentoVenta";

interface SucursalDoc { id: string; codigo: string; nombre: string; direccion: string | null; cp_expedicion: string | null; telefono: string | null; lugar_expedicion: string | null }

/** Reduce la imagen (máx. 480×240 px) y la convierte a data URL para guardarla en la base. */
async function logoComoDataUrl(archivo: File): Promise<string> {
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise<HTMLImageElement>((ok, mal) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error("No se pudo leer la imagen")); i.src = url; });
    const k = Math.min(1, 480 / img.width, 240 / img.height);
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const png = c.toDataURL("image/png");
    return png.length <= 450_000 ? png : c.toDataURL("image/jpeg", 0.85);
  } finally { URL.revokeObjectURL(url); }
}

const ventaEjemplo = (empresa: EmpresaDoc, s: SucursalDoc | undefined): VentaDoc => ({
  id: "ejemplo", serie: s ? `${s.codigo}V` : "PV", folio: 1, fecha: new Date().toISOString(), tipo: "contado", estado: "confirmada",
  subtotal: "620.69", descuento: "0", ieps: "0", iva: "99.31", total: "720.00", pagado: "720.00", saldo: "0", cambio: "0",
  vencimiento: null, comentarios: "Ejemplo de notas de la venta", motivo_cancelacion: null, factura_uuid: null,
  sucursal: s ?? { codigo: "P", nombre: "PRINCIPAL", direccion: null, cp_expedicion: null, telefono: null, lugar_expedicion: null },
  almacen: "ALMACÉN PRINCIPAL",
  cliente: { nombre: "Público en General", razon_social: "Público en General", rfc: "XAXX010101000", correo_facturas: null, telefono: null, es_publico_general: true },
  empresa,
  partidas: [{ renglon: 1, sku: "DEMO-001", nombre: "PRODUCTO DE EJEMPLO 60X60", unidad: "CAJA", unidad_base: "M2", factor: "1.44", cantidad: "2",
    cantidad_base: "2.88", cantidad_entregada: "2", precio_unitario: "360", descuento: "0", total: "720.00", iva_tasa: "0.16", ieps_tasa: "0", vendida_sin_existencia: false }],
  pagos: [{ forma: "tarjeta_debito", importe: "720.00", referencia: null }],
});

export default function EmpresaDocumentos() {
  const [e, setE] = useState<EmpresaDoc>(EMPRESA_VACIA);
  const [sucs, setSucs] = useState<SucursalDoc[]>([]);
  const [admin, setAdmin] = useState(false);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const sb = supabase();
      const [emp, s, perm] = await Promise.all([
        cargarEmpresa(),
        sb.from("sucursales").select("id, codigo, nombre, direccion, cp_expedicion, telefono, lugar_expedicion").order("codigo"),
        sb.rpc("tiene_permiso", { p_permiso: "administrar" }),
      ]);
      if (s.error) throw s.error;
      setE(emp);
      setSucs((s.data ?? []) as SucursalDoc[]);
      setAdmin(perm.data === true);
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async () => {
    setGuardando(true); setMsg(null);
    try {
      const sb = supabase();
      const rfc = e.rfc?.trim().toUpperCase() || null;
      if (rfc && !/^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(rfc)) throw new Error("El RFC no tiene un formato válido.");
      const datos = {
        nombre_emisor: e.nombre_emisor?.trim() || null, razon_social: e.razon_social?.trim() || null, rfc,
        telefono: e.telefono?.trim() || null, condiciones_venta: e.condiciones_venta?.trim() || null,
        remision_titulo: e.remision_titulo.trim() || "Remisión", remision_firma: e.remision_firma, remision_desglosa_iva: e.remision_desglosa_iva,
      };
      let { error } = await sb.from("empresa").update({ ...datos, logos: e.logos, logo: null }).eq("id", 1);
      if (error && /logos/.test(error.message)) {
        // Sin la migración 0011 solo cabe un logotipo
        if (e.logos.length > 1) throw new Error("Para guardar varios logotipos ejecuta en Supabase la migración 20261112000011_logos.sql.");
        ({ error } = await sb.from("empresa").update({ ...datos, logo: e.logos[0] ?? null }).eq("id", 1));
      }
      if (error && /nombre_emisor|condiciones_venta|remision_|column/.test(error.message))
        throw new Error("Falta ejecutar en Supabase las migraciones 20261112000010_documentos.sql y 20261112000011_logos.sql.");
      if (error) throw error;
      for (const s of sucs) {
        const r = await sb.rpc("actualizar_sucursal", { p: { id: s.id, direccion: s.direccion ?? "", cp_expedicion: s.cp_expedicion ?? "", telefono: s.telefono ?? "", lugar_expedicion: s.lugar_expedicion ?? "" } });
        if (r.error) throw r.error;
      }
      setMsg({ tipo: "ok", texto: "Datos guardados. Las remisiones nuevas y las que vuelvas a imprimir ya los usan." });
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); } finally { setGuardando(false); }
  };

  const vistaPrevia = async () => {
    try {
      const b = await generarPdf(ventaEjemplo(e, sucs[0]), "carta");
      window.open(URL.createObjectURL(b), "_blank");
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
  };

  const campo = (k: keyof EmpresaDoc, etiqueta: string, ph = "") => (
    <label className="text-sm">{etiqueta}
      <input className="campo" disabled={!admin} placeholder={ph} value={(e[k] as string | null) ?? ""} onChange={(ev) => setE((x) => ({ ...x, [k]: ev.target.value }))} />
    </label>
  );
  const editSuc = (id: string, cambios: Partial<SucursalDoc>) => setSucs((l) => l.map((s) => (s.id === id ? { ...s, ...cambios } : s)));

  return (
    <div className="p-3 sm:p-5 max-w-5xl">
      {msg && <div role="alert" className={`mb-3 rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}
      {!admin && <div className="mb-3 rounded px-4 py-2 bg-sky-50 text-sky-900 text-sm">Solo un administrador puede modificar estos datos.</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 sm:p-6">
        <div className="barra-seccion">Encabezado de la remisión</div>
        <div className="grid gap-3 sm:grid-cols-2 mt-3">
          {campo("nombre_emisor", "Nombre del emisor (como aparece arriba)")}
          {campo("razon_social", "Razón social (constancia fiscal)")}
          {campo("rfc", "RFC")}
          {campo("telefono", "Teléfono general")}
          {campo("remision_titulo", "Título del documento", "Remisión")}
          <div className="text-sm sm:col-span-2">Logotipos (PNG o JPG, hasta 6; se acomodan en cuadrícula en el orden que tengan aquí)
            <div className="flex flex-wrap items-center gap-3 mt-1">
              {e.logos.map((src, i) => (
                <div key={i} className="flex flex-col items-center gap-1 border border-[var(--borde)] rounded p-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data URL local */}
                  <img src={src} alt={`Logotipo ${i + 1}`} className="h-14 max-w-40 object-contain" />
                  {admin && (
                    <div className="flex gap-2 text-xs">
                      <button disabled={i === 0} className="disabled:opacity-30" aria-label="Mover a la izquierda"
                        onClick={() => setE((x) => { const l = [...x.logos]; [l[i - 1], l[i]] = [l[i], l[i - 1]]; return { ...x, logos: l }; })}>◀</button>
                      <button className="underline text-[var(--peligro)]" onClick={() => setE((x) => ({ ...x, logos: x.logos.filter((_, j) => j !== i) }))}>Quitar</button>
                      <button disabled={i === e.logos.length - 1} className="disabled:opacity-30" aria-label="Mover a la derecha"
                        onClick={() => setE((x) => { const l = [...x.logos]; [l[i + 1], l[i]] = [l[i], l[i + 1]]; return { ...x, logos: l }; })}>▶</button>
                    </div>
                  )}
                </div>
              ))}
              {!e.logos.length && <span className="text-[var(--tenue)]">Sin logotipos</span>}
              {admin && e.logos.length < 6 && (
                <label className="cursor-pointer underline">+ Agregar logotipo
                  <input type="file" accept="image/png,image/jpeg" multiple className="hidden" onChange={async (ev) => {
                    const archivos = [...(ev.target.files ?? [])]; ev.target.value = "";
                    try {
                      const nuevos = await Promise.all(archivos.map(logoComoDataUrl));
                      setE((x) => ({ ...x, logos: [...x.logos, ...nuevos].slice(0, 6) }));
                    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
                  }} />
                </label>
              )}
            </div>
          </div>
        </div>

        <div className="barra-seccion mt-6">Datos por sucursal</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm mt-2 min-w-[720px]">
            <thead style={{ color: "var(--acento)" }}><tr className="text-left">
              <th className="font-normal py-1">Sucursal</th><th className="font-normal">Dirección</th><th className="font-normal w-24">C.P.</th>
              <th className="font-normal w-36">Teléfono</th><th className="font-normal w-56">Lugar de expedición</th>
            </tr></thead>
            <tbody>
              {sucs.map((s) => (
                <tr key={s.id} className="border-t border-[var(--borde)] align-top">
                  <td className="py-2 pr-2 whitespace-nowrap">{s.codigo} - {s.nombre}</td>
                  <td className="py-1 pr-2"><input className="campo" disabled={!admin} value={s.direccion ?? ""} onChange={(ev) => editSuc(s.id, { direccion: ev.target.value })} /></td>
                  <td className="py-1 pr-2"><input className="campo" disabled={!admin} inputMode="numeric" maxLength={5} value={s.cp_expedicion ?? ""} onChange={(ev) => editSuc(s.id, { cp_expedicion: ev.target.value })} /></td>
                  <td className="py-1 pr-2"><input className="campo" disabled={!admin} value={s.telefono ?? ""} onChange={(ev) => editSuc(s.id, { telefono: ev.target.value })} /></td>
                  <td className="py-1"><input className="campo" disabled={!admin} placeholder="Municipio, Estado" value={s.lugar_expedicion ?? ""} onChange={(ev) => editSuc(s.id, { lugar_expedicion: ev.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="barra-seccion mt-6">Pie de la remisión</div>
        <label className="text-sm block mt-3">Condiciones generales (se imprimen al final de cada remisión)
          <textarea className="campo h-48 font-mono text-xs" disabled={!admin} value={e.condiciones_venta ?? ""}
            onChange={(ev) => setE((x) => ({ ...x, condiciones_venta: ev.target.value }))} />
        </label>
        <div className="flex flex-col gap-2 mt-3 text-sm">
          <label><input type="checkbox" disabled={!admin} checked={e.remision_firma} onChange={(ev) => setE((x) => ({ ...x, remision_firma: ev.target.checked }))} /> Imprimir fecha y línea de firma del cliente</label>
          <label><input type="checkbox" disabled={!admin} checked={e.remision_desglosa_iva} onChange={(ev) => setE((x) => ({ ...x, remision_desglosa_iva: ev.target.checked }))} /> Desglosar I.V.A. en la remisión
            <span className="text-[var(--tenue)]"> (si no se marca, los precios se muestran con IVA incluido e “I.V.A. 0%”, como en las notas actuales)</span></label>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button className="px-3 py-2 underline" onClick={vistaPrevia}>Vista previa del PDF</button>
          {admin && <button className="btn-primario" disabled={guardando} onClick={guardar}>{guardando ? "Guardando…" : "Guardar"}</button>}
        </div>
      </section>
    </div>
  );
}
