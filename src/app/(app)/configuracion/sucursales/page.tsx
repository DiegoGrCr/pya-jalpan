"use client";
/** Configuración > Sucursales: alta de sucursales (con almacén, caja y series) y almacenes adicionales. */
import { useCallback, useEffect, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";

interface Almacen { id: string; nombre: string; multisucursal: boolean; activo: boolean }
interface Sucursal { id: string; codigo: string; nombre: string; cp_expedicion: string | null; activa: boolean; almacenes: Almacen[] }

const vacio = { codigo: "", nombre: "", cp_expedicion: "", almacen: "" };

export default function Sucursales() {
  const [lista, setLista] = useState<Sucursal[]>([]);
  const [admin, setAdmin] = useState(false);
  const [form, setForm] = useState(vacio);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const sb = supabase();
      const [{ data, error }, perm] = await Promise.all([
        sb.from("sucursales").select("id, codigo, nombre, cp_expedicion, activa, almacenes(id, nombre, multisucursal, activo)").order("codigo"),
        sb.rpc("tiene_permiso", { p_permiso: "administrar" }),
      ]);
      if (error) throw error;
      setLista((data ?? []) as Sucursal[]);
      setAdmin(perm.data === true);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const crear = async (e: React.FormEvent) => {
    e.preventDefault();
    setGuardando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("crear_sucursal", { p: form });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `Sucursal ${data.codigo} creada con su almacén, caja y series de folios.` });
      setForm(vacio);
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
    finally { setGuardando(false); }
  };

  const agregarAlmacen = async (s: Sucursal) => {
    const nombre = window.prompt(`Nombre del nuevo almacén de ${s.nombre}`);
    if (!nombre) return;
    try {
      const { error } = await supabase().rpc("crear_almacen", { p: { sucursal_id: s.id, nombre } });
      if (error) throw error;
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
  };

  const alternarActiva = async (s: Sucursal) => {
    try {
      const { error } = await supabase().rpc("actualizar_sucursal", { p: { id: s.id, activa: !s.activa } });
      if (error) throw error;
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
  };

  const campo = (k: keyof typeof vacio, etiqueta: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1 text-sm">
      {etiqueta}
      <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })}
        className="border rounded px-3 py-2 bg-[var(--panel)]" {...extra} />
    </label>
  );

  return (
    <div className="p-4 sm:p-6 max-w-5xl flex flex-col gap-5">
      <h1 className="text-2xl font-semibold">Sucursales</h1>

      {msg && (
        <div role="alert" className={`rounded-md px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
          {msg.texto}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border bg-[var(--panel)]">
        <table className="w-full text-sm">
          <thead className="text-left opacity-80">
            <tr><th className="p-2">Código</th><th>Nombre</th><th>CP expedición</th><th>Almacenes</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>
            {lista.map((s) => (
              <tr key={s.id} className="border-t align-top">
                <td className="p-2 font-mono">{s.codigo}</td>
                <td className="py-2">{s.nombre}</td>
                <td className="py-2">{s.cp_expedicion ?? "—"}</td>
                <td className="py-2">
                  {s.almacenes.map((a) => <div key={a.id}>{a.nombre}{a.multisucursal ? " (multisucursal)" : ""}</div>)}
                  {admin && <button onClick={() => agregarAlmacen(s)} className="text-xs underline">+ Agregar almacén</button>}
                </td>
                <td className="py-2">{s.activa ? "Activa" : "Inactiva"}</td>
                <td className="py-2 pr-2">
                  {admin && <button onClick={() => alternarActiva(s)} className="text-xs underline">{s.activa ? "Desactivar" : "Activar"}</button>}
                </td>
              </tr>
            ))}
            {lista.length === 0 && <tr><td colSpan={6} className="p-4 text-center opacity-60">Sin sucursales.</td></tr>}
          </tbody>
        </table>
      </div>

      {admin ? (
        <form onSubmit={crear} className="rounded-lg border bg-[var(--panel)] p-4 grid gap-3 sm:grid-cols-2">
          <h2 className="sm:col-span-2 font-semibold">Nueva sucursal</h2>
          {campo("codigo", "Código (1 a 4 letras/números; prefijo de folios)", { required: true, maxLength: 4, placeholder: "Ej. S2" })}
          {campo("nombre", "Nombre", { required: true })}
          {campo("cp_expedicion", "Código postal de expedición", { inputMode: "numeric", maxLength: 5 })}
          {campo("almacen", "Nombre del almacén (opcional)")}
          <p className="sm:col-span-2 text-xs opacity-70">
            Se crean automáticamente su almacén, su caja y sus series de folios ({form.codigo.toUpperCase() || "XX"}V ventas,
            {" "}{form.codigo.toUpperCase() || "XX"}C cotizaciones, {form.codigo.toUpperCase() || "XX"}F facturas…). No uses prefijos de Bind.
          </p>
          <div className="sm:col-span-2">
            <button disabled={guardando} className="rounded-md bg-emerald-600 text-white px-5 py-2 disabled:opacity-50">
              {guardando ? "Creando…" : "Crear sucursal"}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm opacity-70">Solo un administrador puede crear o modificar sucursales.</p>
      )}
    </div>
  );
}
