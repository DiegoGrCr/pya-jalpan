"use client";
/** Configuración > Usuarios: alta de usuarios (p. ej. uno por sucursal), rol, sucursales, contraseña y estado. */
import { useCallback, useEffect, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { ROLES, Rol, USUARIO_VALIDO } from "@/lib/usuarios";

interface Sucursal { id: string; codigo: string; nombre: string; activa: boolean }
interface Usuario { user_id: string; nombre: string; rol: Rol; activo: boolean; usuario: string | null; propietario?: boolean; usuario_sucursales: { sucursal_id: string }[] }

const vacio = { usuario: "", nombre: "", contrasena: "", rol: "cajero" as Rol, sucursales: [] as string[] };

async function llamar(cuerpo: Record<string, unknown>) {
  const r = await fetch("/api/usuarios", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cuerpo) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "No se pudo guardar.");
  return d;
}

export default function Usuarios() {
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [propietario, setPropietario] = useState(false);
  const [yo, setYo] = useState<string | null>(null);
  const [form, setForm] = useState(vacio);
  const [editando, setEditando] = useState<string | null>(null);
  const [edicion, setEdicion] = useState<{ nombre: string; rol: Rol; sucursales: string[] }>({ nombre: "", rol: "cajero", sucursales: [] });
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const sb = supabase();
      const [u, s, a, sesion, prop] = await Promise.all([
        sb.from("perfiles").select("user_id, nombre, rol, activo, usuario, propietario, usuario_sucursales(sucursal_id)").order("nombre"),
        sb.from("sucursales").select("id, codigo, nombre, activa").order("codigo"),
        sb.rpc("es_admin"),
        sb.auth.getUser(),
        sb.rpc("es_propietario"),
      ]);
      if (u.error) {
        if (/usuario/.test(u.error.message) && /exist|could not find/i.test(u.error.message))
          throw new Error("Falta ejecutar la migración 20261113000013_usuarios.sql en Supabase.");
        throw u.error;
      }
      setUsuarios((u.data ?? []) as Usuario[]);
      setSucursales((s.data ?? []) as Sucursal[]);
      setAdmin(a.data === true);
      setPropietario(prop.data === true);
      setYo(sesion.data.user?.id ?? null);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const ejecutar = async (fn: () => Promise<unknown>, ok: string) => {
    setTrabajando(true); setMsg(null);
    try { await fn(); setMsg({ tipo: "ok", texto: ok }); await cargar(); return true; }
    catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); return false; }
    finally { setTrabajando(false); }
  };

  const crear = async (e: React.FormEvent) => {
    e.preventDefault();
    const usuario = form.usuario.trim().toLowerCase();
    if (await ejecutar(() => llamar({ accion: "crear", ...form, usuario }), `Usuario "${usuario}" creado. Ya puede iniciar sesión con su usuario y contraseña.`))
      setForm(vacio);
  };

  const cambiarContrasena = (u: Usuario) => {
    const c = window.prompt(`Nueva contraseña para ${u.nombre} (mínimo 8 caracteres)`);
    if (!c) return;
    if (c.length < 8) { setMsg({ tipo: "error", texto: "La contraseña debe tener al menos 8 caracteres." }); return; }
    ejecutar(() => llamar({ accion: "actualizar", user_id: u.user_id, contrasena: c }), `Contraseña de ${u.nombre} actualizada.`);
  };

  const alternarActivo = (u: Usuario) =>
    ejecutar(() => llamar({ accion: "actualizar", user_id: u.user_id, activo: !u.activo }),
      u.activo ? `${u.nombre} desactivado: ya no puede iniciar sesión.` : `${u.nombre} activado.`);

  const guardarEdicion = async (u: Usuario) => {
    if (await ejecutar(() => llamar({ accion: "actualizar", user_id: u.user_id, ...edicion }), `Cambios de ${edicion.nombre} guardados.`))
      setEditando(null);
  };

  const nombreSuc = (id: string) => { const s = sucursales.find((x) => x.id === id); return s ? `${s.codigo} - ${s.nombre}` : "?"; };
  const casillas = (sel: string[], cambiar: (v: string[]) => void) => (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {sucursales.filter((s) => s.activa || sel.includes(s.id)).map((s) => (
        <label key={s.id} className="text-sm whitespace-nowrap">
          <input type="checkbox" checked={sel.includes(s.id)}
            onChange={(e) => cambiar(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} /> {s.codigo} - {s.nombre}
        </label>
      ))}
    </div>
  );

  if (admin === false) return <div className="p-5">Solo un administrador puede administrar usuarios.</div>;

  const usuarioInvalido = form.usuario !== "" && !USUARIO_VALIDO.test(form.usuario.trim().toLowerCase());

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Usuarios</h1>
      {msg && (
        <div role="alert" className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4">
        <div className="barra-seccion">Nuevo usuario</div>
        <form onSubmit={crear} className="grid gap-3 mt-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <label>Usuario (para iniciar sesión)
            <input className={`campo ${usuarioInvalido ? "campo-requerido" : ""}`} required autoComplete="off" placeholder="p. ej. sucursal2"
              value={form.usuario} onChange={(e) => setForm({ ...form, usuario: e.target.value.replace(/\s/g, "").toLowerCase() })} />
            {usuarioInvalido && <span className="text-xs text-[var(--peligro)]">3 a 30: minúsculas, números, punto o guion</span>}
          </label>
          <label>Nombre
            <input className="campo" required placeholder="p. ej. Mostrador sucursal 2" value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} />
          </label>
          <label>Contraseña (mínimo 8)
            <input className="campo" required type="password" autoComplete="new-password" minLength={8}
              value={form.contrasena} onChange={(e) => setForm({ ...form, contrasena: e.target.value })} />
          </label>
          <label>Rol
            <select className="campo" value={form.rol} onChange={(e) => setForm({ ...form, rol: e.target.value as Rol })}>
              {Object.entries(ROLES).filter(([k]) => propietario || k !== "administrador").map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </label>
          <div className="sm:col-span-2 lg:col-span-4">
            <div className="mb-1">Sucursales donde puede trabajar{form.rol === "administrador" ? " (el administrador ve todas)" : ""}</div>
            {casillas(form.sucursales, (v) => setForm({ ...form, sucursales: v }))}
          </div>
          <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
            <button className="btn-primario" disabled={trabajando || usuarioInvalido}>{trabajando ? "Guardando…" : "Crear usuario"}</button>
          </div>
        </form>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left"><th className="py-1 font-normal">Usuario</th><th className="font-normal">Nombre</th><th className="font-normal">Rol</th>
              <th className="font-normal">Sucursales</th><th className="font-normal">Estado</th><th></th></tr>
          </thead>
          <tbody>
            {usuarios.map((u) => {
              const sus = u.usuario_sucursales.map((x) => x.sucursal_id);
              const esYo = u.user_id === yo;
              // Administradores y propietario solo los administra el propietario
              const editable = propietario || (u.rol !== "administrador" && !u.propietario);
              if (editando === u.user_id) return (
                <tr key={u.user_id} className="border-t border-[var(--borde)] align-top">
                  <td className="py-2">{u.usuario ?? <span className="text-[var(--tenue)]">(correo)</span>}</td>
                  <td className="py-1"><input className="campo" value={edicion.nombre} onChange={(e) => setEdicion({ ...edicion, nombre: e.target.value })} /></td>
                  <td className="py-1">
                    <select className="campo" value={edicion.rol} disabled={esYo} onChange={(e) => setEdicion({ ...edicion, rol: e.target.value as Rol })}>
                      {Object.entries(ROLES).filter(([k]) => propietario || k !== "administrador").map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                    </select>
                  </td>
                  <td className="py-2">{casillas(edicion.sucursales, (v) => setEdicion({ ...edicion, sucursales: v }))}</td>
                  <td className="py-2">{u.activo ? "Activo" : "Inactivo"}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <button className="underline mr-3" onClick={() => setEditando(null)}>Cancelar</button>
                    <button className="btn-primario" disabled={trabajando} onClick={() => guardarEdicion(u)}>Guardar</button>
                  </td>
                </tr>
              );
              return (
                <tr key={u.user_id} className="border-t border-[var(--borde)] align-top" style={u.activo ? undefined : { opacity: 0.55 }}>
                  <td className="py-2">{u.usuario ?? <span className="text-[var(--tenue)]">(correo)</span>}</td>
                  <td className="py-2">{u.nombre}{u.propietario && <span className="text-xs text-[var(--tenue)]"> (propietario)</span>}{esYo && <span className="text-xs text-[var(--tenue)]"> (tú)</span>}</td>
                  <td className="py-2">{ROLES[u.rol] ?? u.rol}</td>
                  <td className="py-2">{u.rol === "administrador" && !sus.length ? "Todas" : sus.map(nombreSuc).join(", ") || "—"}</td>
                  <td className="py-2">{u.activo ? "Activo" : "Inactivo"}</td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {editable && <>
                    <button className="underline mr-3" onClick={() => { setEditando(u.user_id); setEdicion({ nombre: u.nombre, rol: u.rol, sucursales: sus }); }}>Editar</button>
                    <button className="underline mr-3" disabled={trabajando} onClick={() => cambiarContrasena(u)}>Contraseña</button>
                    {!esYo && !u.propietario && <button className="underline" disabled={trabajando} onClick={() => alternarActivo(u)}>{u.activo ? "Desactivar" : "Activar"}</button>}
                    </>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
