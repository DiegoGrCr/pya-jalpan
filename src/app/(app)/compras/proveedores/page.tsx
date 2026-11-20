"use client";
/** Compras › Proveedores: alta, edición y desactivación (guardar_proveedor, 0047). */
import { useCallback, useEffect, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { DialogoProveedor, type Proveedor } from "@/components/DialogoProveedor";

export default function Proveedores() {
  const [filas, setFilas] = useState<Proveedor[]>([]);
  const [texto, setTexto] = useState("");
  const [inactivos, setInactivos] = useState(false);
  const [editando, setEditando] = useState<Proveedor | null | undefined>(undefined);   // undefined = cerrado, null = nuevo
  const [msg, setMsg] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    let q = supabase().from("proveedores").select("id, nombre, rfc, contacto, telefono, correo, dias_credito, activo").order("nombre");
    if (!inactivos) q = q.eq("activo", true);
    const { data, error } = await q;
    if (error) { setMsg(mensajeError(error)); return; }
    setFilas((data ?? []) as Proveedor[]);
  }, [inactivos]);
  useEffect(() => { cargar(); }, [cargar]);

  const t = texto.trim().toLowerCase();
  const vis = t ? filas.filter((x) => `${x.nombre} ${x.rfc ?? ""} ${x.contacto ?? ""}`.toLowerCase().includes(t)) : filas;

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Proveedores</h1>
        <button className="btn-primario" onClick={() => setEditando(null)}>+ Nuevo proveedor</button>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-4 items-end text-sm">
        <label className="flex-1 min-w-[220px]">Buscar<input className="campo" placeholder="Nombre, RFC o contacto" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label><input type="checkbox" checked={inactivos} onChange={(e) => setInactivos(e.target.checked)} /> Ver inactivos</label>
      </section>
      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Nombre</th><th className="font-normal">RFC</th><th className="font-normal">Contacto</th>
            <th className="font-normal">Teléfono</th><th className="font-normal">Correo</th><th className="font-normal text-right pr-2">Días crédito</th></tr></thead>
          <tbody>
            {vis.map((x) => (
              <tr key={x.id} className="border-b border-[var(--borde)] cursor-pointer hover:bg-[var(--resalte)]" onClick={() => setEditando(x)}>
                <td className="p-2">{x.nombre}{!x.activo && <span className="text-[var(--tenue)]"> (inactivo)</span>}</td>
                <td>{x.rfc ?? "—"}</td><td>{x.contacto ?? "—"}</td><td>{x.telefono ?? "—"}</td><td>{x.correo ?? "—"}</td>
                <td className="text-right pr-2">{x.dias_credito}</td>
              </tr>
            ))}
            {!vis.length && <tr><td colSpan={6} className="p-6 text-center text-[var(--tenue)]">No hay proveedores. Da de alta el primero con “+ Nuevo proveedor”.</td></tr>}
          </tbody>
        </table>
      </section>
      {editando !== undefined && (
        <DialogoProveedor inicial={editando} alCerrar={() => setEditando(undefined)} alGuardar={() => { setEditando(undefined); cargar(); }} />
      )}
    </div>
  );
}
