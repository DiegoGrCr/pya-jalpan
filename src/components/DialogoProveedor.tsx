"use client";
/** Diálogo de alta/edición de proveedor (guardar_proveedor, 0047); se usa en Proveedores y en la recepción. */
import { useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";

export interface Proveedor { id: string; nombre: string; rfc: string | null; contacto: string | null; telefono: string | null; correo: string | null; dias_credito: number; activo: boolean }
type Edicion = Omit<Proveedor, "id" | "dias_credito"> & { id?: string; dias_credito: string };
const VACIO: Edicion = { nombre: "", rfc: "", contacto: "", telefono: "", correo: "", dias_credito: "0", activo: true };

/** Diálogo de alta/edición; también se usa desde la recepción de mercancía */
export function DialogoProveedor({ inicial, alCerrar, alGuardar }: { inicial?: Proveedor | null; alCerrar: () => void; alGuardar: (id: string, nombre: string) => void }) {
  const [e, setE] = useState<Edicion>(inicial ? { ...inicial, dias_credito: String(inicial.dias_credito) } : VACIO);
  const [error, setError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const guardar = async () => {
    setGuardando(true); setError(null);
    try {
      const { data, error } = await supabase().rpc("guardar_proveedor", { p: e });
      if (error) {
        if (/guardar_proveedor/.test(error.message)) throw new Error("Falta ejecutar la migración 20261120000047_recepcion_mercancia.sql en Supabase.");
        throw error;
      }
      alGuardar(data.proveedor_id, e.nombre.trim());
    } catch (err) { setError(mensajeError(err)); } finally { setGuardando(false); }
  };
  const campo = (k: keyof Edicion, etiqueta: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label>{etiqueta}<input className="campo" value={String(e[k] ?? "")} onChange={(ev) => setE({ ...e, [k]: ev.target.value })} {...extra} /></label>
  );
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={alCerrar}>
      <div role="dialog" aria-label="Proveedor" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-lg p-5 text-sm" onClick={(ev) => ev.stopPropagation()}>
        <h2 className="text-lg font-semibold">{e.id ? "Editar proveedor" : "Nuevo proveedor"}</h2>
        {error && <div role="alert" className="mt-2 rounded px-3 py-2 bg-amber-100 text-amber-900">{error}</div>}
        <div className="grid gap-3 mt-3 sm:grid-cols-2">
          <div className="sm:col-span-2">{campo("nombre", "Nombre", { autoFocus: true })}</div>
          {campo("rfc", "RFC (opcional)", { onChange: (ev) => setE({ ...e, rfc: ev.target.value.toUpperCase() }) })}
          {campo("dias_credito", "Días de crédito", { inputMode: "numeric" })}
          {campo("contacto", "Contacto")}
          {campo("telefono", "Teléfono", { inputMode: "tel" })}
          <div className="sm:col-span-2">{campo("correo", "Correo", { type: "email" })}</div>
          {e.id && <label className="sm:col-span-2"><input type="checkbox" checked={e.activo} onChange={(ev) => setE({ ...e, activo: ev.target.checked })} /> Activo</label>}
        </div>
        <div className="flex justify-end gap-3 mt-4">
          <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={alCerrar}>Cancelar</button>
          <button className="btn-primario" disabled={guardando || !e.nombre.trim()} onClick={guardar}>{guardando ? "Guardando…" : "Guardar"}</button>
        </div>
      </div>
    </div>
  );
}
