"use client";
/** Configuración > Sucursales: alta de sucursales (con almacén, caja y series) y almacenes adicionales. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { USUARIO_VALIDO } from "@/lib/usuarios";

interface Almacen { id: string; nombre: string; multisucursal: boolean; activo: boolean }
interface Sucursal {
  id: string; codigo: string; nombre: string; cp_expedicion: string | null; activa: boolean; almacenes: Almacen[];
  series: { tipo_documento: string; prefijo: string; siguiente: number; activa: boolean }[];
  almacen_predeterminado_id?: string | null;
}

interface UsuarioSuc { user_id: string; usuario: string | null; nombre: string; activo: boolean; usuario_sucursales: { sucursal_id: string }[] }

const vacio = { codigo: "", nombre: "", cp_expedicion: "", almacen: "", usuario: "", contrasena: "" };
const nuevoAcceso = { usuario: "", contrasena: "" };

/** Crea un usuario vendedor/cajero para la sucursal (ruta del servidor, solo administradores). */
async function crearUsuarioSucursal(sucursalId: string, nombreSucursal: string, usuario: string, contrasena: string) {
  const r = await fetch("/api/usuarios", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accion: "crear", usuario, contrasena, nombre: `Sucursal ${nombreSucursal}`, rol: "cajero", sucursales: [sucursalId] }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "No se pudo crear el usuario.");
}

export default function Sucursales() {
  const [lista, setLista] = useState<Sucursal[]>([]);
  const [usuarios, setUsuarios] = useState<UsuarioSuc[]>([]);
  const [accesoPara, setAccesoPara] = useState<string | null>(null);
  const [acceso, setAcceso] = useState(nuevoAcceso);
  const [admin, setAdmin] = useState(false);
  const [propietario, setPropietario] = useState(false);
  const [form, setForm] = useState(vacio);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const sb = supabase();
      const consulta = (extra: string) => sb.from("sucursales")
        .select(`id, codigo, nombre, cp_expedicion, activa, almacenes!almacenes_sucursal_id_fkey(id, nombre, multisucursal, activo), series(tipo_documento, prefijo, siguiente, activa)${extra}`).order("codigo");
      const [primera, perm, us, prop] = await Promise.all([
        consulta(", almacen_predeterminado_id"),
        sb.rpc("tiene_permiso", { p_permiso: "administrar" }),
        sb.from("perfiles").select("user_id, usuario, nombre, activo, usuario_sucursales(sucursal_id)").order("nombre"),
        sb.rpc("es_propietario"),
      ]);
      // Compatibilidad: sin la migración 0029 no existe almacen_predeterminado_id
      const { data, error } = primera.error ? await consulta("") : primera;
      if (error) throw error;
      setLista((data ?? []) as Sucursal[]);
      setAdmin(perm.data === true);
      setPropietario(prop.data === true);
      setUsuarios(us.error ? [] : (us.data ?? []) as UsuarioSuc[]);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Folio de remisiones: abreviación de la sucursal y número con el que sigue (p. ej. AR 1)
  const [folioPara, setFolioPara] = useState<string | null>(null);
  const [folio, setFolio] = useState({ prefijo: "", siguiente: "1" });
  const serieVenta = (s: Sucursal) => s.series?.find((x) => x.tipo_documento === "venta" && x.activa);
  const guardarFolio = async (s: Sucursal) => {
    setGuardando(true); setMsg(null);
    try {
      const { error } = await supabase().rpc("guardar_serie", { p: { sucursal_id: s.id, tipo_documento: "venta", prefijo: folio.prefijo, siguiente: Number(folio.siguiente) } });
      if (error) {
        if (/guardar_serie/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000028_folio_y_almacen_por_renglon.sql en Supabase.");
        throw error;
      }
      setFolioPara(null);
      setMsg({ tipo: "ok", texto: `${s.nombre}: la próxima remisión será ${folio.prefijo.toUpperCase()} ${folio.siguiente}.` });
      await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setGuardando(false); }
  };

  const crear = async (e: React.FormEvent) => {
    e.preventDefault();
    setGuardando(true); setMsg(null);
    try {
      const { usuario, contrasena, ...datos } = form;
      const u = usuario.trim().toLowerCase();
      if (u && !USUARIO_VALIDO.test(u)) throw new Error("El usuario debe tener de 3 a 30 caracteres: minúsculas, números, punto o guion.");
      if (u && contrasena.length < 8) throw new Error("La contraseña del usuario debe tener al menos 8 caracteres.");
      const { data, error } = await supabase().rpc("crear_sucursal", { p: datos });
      if (error) throw error;
      let texto = `Sucursal ${data.codigo} creada con su almacén, caja y series de folios.`;
      if (u) {
        try { await crearUsuarioSucursal(data.sucursal_id, datos.nombre, u, contrasena); texto += ` Usuario "${u}" listo para iniciar sesión.`; }
        catch (e2) { texto += ` Pero el usuario no se creó: ${mensajeError(e2)} Créalo con "+ Usuario" en la tabla.`; }
      }
      setMsg({ tipo: "ok", texto });
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

  const accionAlmacen = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setMsg(null);
    try {
      const { error } = await fn();
      if (error) {
        if (/almacen_predeterminado|actualizar_almacen|eliminar_almacen/.test(error.message) && /function|función/.test(error.message))
          throw new Error("Falta ejecutar la migración 20261118000029_almacenes_admin.sql en Supabase.");
        throw error;
      }
      setMsg({ tipo: "ok", texto: ok });
      await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  };
  const predeterminado = (s: Sucursal, a: Almacen) =>
    accionAlmacen(() => supabase().rpc("almacen_predeterminado", { p: { sucursal_id: s.id, almacen_id: a.id } }), `${a.nombre} es ahora el almacén predeterminado de ${s.nombre}.`);
  const renombrar = (a: Almacen) => {
    const nombre = window.prompt("Nuevo nombre del almacén", a.nombre);
    if (!nombre || nombre.trim() === a.nombre) return;
    accionAlmacen(() => supabase().rpc("actualizar_almacen", { p: { id: a.id, nombre: nombre.trim() } }), "Almacén renombrado.");
  };
  const alternarAlmacen = (a: Almacen) => {
    if (a.activo && !window.confirm(`¿Desactivar ${a.nombre}? Ya no aparecerá para vender ni mover inventario.`)) return;
    accionAlmacen(() => supabase().rpc("actualizar_almacen", { p: { id: a.id, activo: !a.activo } }), a.activo ? "Almacén desactivado." : "Almacén activado.");
  };
  const eliminarAlmacen = (a: Almacen) => {
    if (!window.confirm(`¿Eliminar ${a.nombre}? Solo se puede si nunca se usó. No se puede deshacer.`)) return;
    accionAlmacen(() => supabase().rpc("eliminar_almacen", { p_id: a.id }), "Almacén eliminado.");
  };

  const alternarActiva = async (s: Sucursal) => {
    try {
      const { error } = await supabase().rpc("actualizar_sucursal", { p: { id: s.id, activa: !s.activa } });
      if (error) throw error;
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); }
  };

  const guardarAcceso = async (s: Sucursal) => {
    const u = acceso.usuario.trim().toLowerCase();
    if (!USUARIO_VALIDO.test(u)) { setMsg({ tipo: "error", texto: "El usuario debe tener de 3 a 30 caracteres: minúsculas, números, punto o guion." }); return; }
    if (acceso.contrasena.length < 8) { setMsg({ tipo: "error", texto: "La contraseña debe tener al menos 8 caracteres." }); return; }
    setGuardando(true); setMsg(null);
    try {
      await crearUsuarioSucursal(s.id, s.nombre, u, acceso.contrasena);
      setMsg({ tipo: "ok", texto: `Usuario "${u}" creado para ${s.nombre}. Ya puede iniciar sesión.` });
      setAccesoPara(null); setAcceso(nuevoAcceso);
      await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setGuardando(false); }
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
            <tr><th className="p-2">Código</th><th>Nombre</th><th>CP expedición</th><th>Folio de remisiones</th><th>Almacenes</th><th>Usuarios</th><th>Estado</th><th></th></tr>
          </thead>
          <tbody>
            {lista.map((s) => (
              <tr key={s.id} className="border-t align-top">
                <td className="p-2 font-mono">{s.codigo}</td>
                <td className="py-2">{s.nombre}</td>
                <td className="py-2">{s.cp_expedicion ?? "—"}</td>
                <td className="py-2">
                  {folioPara === s.id ? (
                    <div className="flex flex-col gap-1 max-w-[220px]">
                      <label className="text-xs">Abreviación
                        <input className="border rounded px-2 py-1 w-full uppercase" maxLength={6} placeholder="p. ej. AR" value={folio.prefijo}
                          onChange={(e) => setFolio({ ...folio, prefijo: e.target.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase() })} />
                      </label>
                      <label className="text-xs">Siguiente número
                        <input className="border rounded px-2 py-1 w-full" inputMode="numeric" value={folio.siguiente}
                          onChange={(e) => setFolio({ ...folio, siguiente: e.target.value.replace(/\D/g, "") })} />
                      </label>
                      <div className="flex gap-3 text-xs">
                        <button disabled={guardando || !folio.prefijo || !Number(folio.siguiente)} onClick={() => guardarFolio(s)} className="underline font-semibold">Guardar</button>
                        <button onClick={() => setFolioPara(null)} className="underline">Cancelar</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="font-mono">{serieVenta(s) ? `${serieVenta(s)!.prefijo} ${serieVenta(s)!.siguiente}` : "—"}</div>
                      <div className="text-xs opacity-60">próxima remisión</div>
                      {(!serieVenta(s) || /^\d+V$/.test(serieVenta(s)!.prefijo)) && (
                        <div className="text-xs text-amber-700">Serie automática: pon la abreviación de la sucursal</div>
                      )}
                      {admin && <button className="text-xs underline" onClick={() => { const sv = serieVenta(s); setFolioPara(s.id); setFolio({ prefijo: sv?.prefijo ?? "", siguiente: "1" }); }}>Cambiar</button>}
                    </>
                  )}
                </td>
                <td className="py-2">
                  {[...s.almacenes].sort((a, b) => Number(b.activo) - Number(a.activo) || a.nombre.localeCompare(b.nombre)).map((a) => {
                    const pred = s.almacen_predeterminado_id === a.id;
                    return (
                      <div key={a.id} className="mb-1" style={a.activo ? undefined : { opacity: 0.5 }}>
                        <div>
                          {a.nombre}{a.multisucursal ? " (multisucursal)" : ""}{!a.activo ? " (inactivo)" : ""}
                          {pred && <span className="ml-1 px-1.5 rounded text-xs bg-emerald-100 text-emerald-900">predeterminado</span>}
                        </div>
                        {propietario && (
                          <div className="flex flex-wrap gap-x-2 text-xs">
                            {a.activo && !pred && s.almacen_predeterminado_id !== undefined && <button className="underline" onClick={() => predeterminado(s, a)}>Hacer predeterminado</button>}
                            <button className="underline" onClick={() => renombrar(a)}>Renombrar</button>
                            {!pred && <button className="underline" onClick={() => alternarAlmacen(a)}>{a.activo ? "Desactivar" : "Activar"}</button>}
                            {!pred && <button className="underline text-[var(--peligro)]" onClick={() => eliminarAlmacen(a)}>Eliminar</button>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {propietario && <button onClick={() => agregarAlmacen(s)} className="text-xs underline">+ Agregar almacén</button>}
                </td>
                <td className="py-2">
                  {usuarios.filter((u) => u.usuario_sucursales.some((x) => x.sucursal_id === s.id)).map((u) => (
                    <div key={u.user_id} style={u.activo ? undefined : { opacity: 0.5 }}>{u.usuario ?? u.nombre}{u.activo ? "" : " (inactivo)"}</div>
                  ))}
                  {admin && accesoPara !== s.id && (
                    <button onClick={() => { setAccesoPara(s.id); setAcceso(nuevoAcceso); }} className="text-xs underline">+ Usuario</button>
                  )}
                  {admin && accesoPara === s.id && (
                    <div className="flex flex-col gap-1 mt-1 max-w-[220px]">
                      <input className="border rounded px-2 py-1" placeholder="Usuario" autoComplete="off" value={acceso.usuario}
                        onChange={(e) => setAcceso({ ...acceso, usuario: e.target.value.replace(/\s/g, "").toLowerCase() })} />
                      <input className="border rounded px-2 py-1" type="password" placeholder="Contraseña (mín. 8)" autoComplete="new-password" value={acceso.contrasena}
                        onChange={(e) => setAcceso({ ...acceso, contrasena: e.target.value })} />
                      <div className="flex gap-3 text-xs">
                        <button disabled={guardando} onClick={() => guardarAcceso(s)} className="underline font-semibold">Crear</button>
                        <button onClick={() => setAccesoPara(null)} className="underline">Cancelar</button>
                      </div>
                    </div>
                  )}
                </td>
                <td className="py-2">{s.activa ? "Activa" : "Inactiva"}</td>
                <td className="py-2 pr-2">
                  {propietario && <button onClick={() => alternarActiva(s)} className="text-xs underline">{s.activa ? "Desactivar" : "Activar"}</button>}
                </td>
              </tr>
            ))}
            {lista.length === 0 && <tr><td colSpan={8} className="p-4 text-center opacity-60">Sin sucursales.</td></tr>}
          </tbody>
        </table>
      </div>

      {propietario ? (
        <form onSubmit={crear} className="rounded-lg border bg-[var(--panel)] p-4 grid gap-3 sm:grid-cols-2">
          <h2 className="sm:col-span-2 font-semibold">Nueva sucursal</h2>
          {campo("codigo", "Código (1 a 4 letras/números; prefijo de folios)", { required: true, maxLength: 4, placeholder: "Ej. S2" })}
          {campo("nombre", "Nombre", { required: true })}
          {campo("cp_expedicion", "Código postal de expedición", { inputMode: "numeric", maxLength: 5 })}
          {campo("almacen", "Nombre del almacén (opcional)")}
          {campo("usuario", "Usuario de la sucursal (para iniciar sesión)", { placeholder: "Ej. sucursal2", autoComplete: "off" })}
          {campo("contrasena", "Contraseña del usuario (mínimo 8)", { type: "password", autoComplete: "new-password" })}
          <p className="sm:col-span-2 text-xs opacity-70">
            Se crean automáticamente su almacén, su caja y sus series de folios ({form.codigo.toUpperCase() || "XX"}V ventas,
            {" "}{form.codigo.toUpperCase() || "XX"}C cotizaciones, {form.codigo.toUpperCase() || "XX"}F facturas…). No uses prefijos de Bind.
            {" "}Si escribes usuario y contraseña, se crea también su usuario (vendedor/cajero). Para cambiar contraseñas o roles ve a{" "}
            <Link href="/configuracion/usuarios" className="underline">Usuarios</Link>.
          </p>
          <div className="sm:col-span-2">
            <button disabled={guardando} className="rounded-md bg-emerald-600 text-white px-5 py-2 disabled:opacity-50">
              {guardando ? "Creando…" : "Crear sucursal"}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-sm opacity-70">Solo el propietario de la cuenta puede crear sucursales y almacenes.</p>
      )}
    </div>
  );
}
