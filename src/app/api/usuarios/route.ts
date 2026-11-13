/**
 * Alta y mantenimiento de usuarios (solo administradores).
 * - Cuenta de acceso (usuario/contraseña/bloqueo): Supabase Auth con la clave secreta,
 *   que vive SOLO en el servidor (variable sin NEXT_PUBLIC_).
 * - Perfil, rol y sucursales: función guardar_usuario con la sesión del administrador
 *   (valida permisos y deja registro en la bitácora).
 */
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { supabaseServidor } from "@/lib/supabase/server";
import { ROLES, USUARIO_VALIDO, correoDeUsuario } from "@/lib/usuarios";

export const dynamic = "force-dynamic";

const BLOQUEO = "876000h"; // ~100 años: un usuario desactivado no puede iniciar sesión

function clienteAdmin(): SupabaseClient | null {
  const secreta = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secreta) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, secreta, { auth: { persistSession: false, autoRefreshToken: false } });
}

const error = (texto: string, status = 400) => NextResponse.json({ error: texto }, { status });

interface Cuerpo {
  accion: "crear" | "actualizar";
  user_id?: string;
  usuario?: string;
  nombre?: string;
  contrasena?: string;
  rol?: string;
  sucursales?: string[];
  activo?: boolean;
}

export async function POST(req: Request) {
  // Quien llama debe ser administrador activo (se valida con SU sesión)
  const sb = await supabaseServidor();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return error("Inicia sesión de nuevo.", 401);
  const { data: esAdmin } = await sb.rpc("es_admin");
  if (esAdmin !== true) return error("Solo un administrador puede administrar usuarios.", 403);

  const admin = clienteAdmin();
  if (!admin) return error("Falta configurar la clave secreta de Supabase (SUPABASE_SECRET_KEY) en el servidor.", 500);

  let b: Cuerpo;
  try { b = await req.json(); } catch { return error("Solicitud inválida."); }
  if (b.rol !== undefined && !(b.rol in ROLES)) return error("Rol no válido.");
  if (b.contrasena !== undefined && b.contrasena !== "" && b.contrasena.length < 8) return error("La contraseña debe tener al menos 8 caracteres.");
  if (b.sucursales !== undefined && (!Array.isArray(b.sucursales) || b.sucursales.some((s) => typeof s !== "string"))) return error("Sucursales inválidas.");

  if (b.accion === "crear") {
    const usuario = (b.usuario ?? "").trim().toLowerCase();
    const nombre = (b.nombre ?? "").trim();
    if (!USUARIO_VALIDO.test(usuario)) return error("El usuario debe tener de 3 a 30 caracteres: minúsculas, números, punto o guion, sin espacios.");
    if (!nombre) return error("Escribe el nombre.");
    if (!b.contrasena) return error("Escribe la contraseña.");
    if (!b.rol) return error("Elige el rol.");
    if (b.rol !== "administrador" && !b.sucursales?.length) return error("Asigna al menos una sucursal.");

    const { data: existe } = await sb.from("perfiles").select("user_id").eq("usuario", usuario).maybeSingle();
    if (existe) return error(`El usuario "${usuario}" ya existe.`);

    const { data: creado, error: e1 } = await admin.auth.admin.createUser({
      email: correoDeUsuario(usuario), password: b.contrasena, email_confirm: true, user_metadata: { nombre, usuario },
    });
    if (e1 || !creado.user) {
      return error(/already/i.test(e1?.message ?? "") ? `El usuario "${usuario}" ya existe.` : (e1?.message ?? "No se pudo crear el usuario."));
    }
    const { error: e2 } = await sb.rpc("guardar_usuario", { p: { user_id: creado.user.id, usuario, nombre, rol: b.rol, sucursales: b.sucursales ?? [] } });
    if (e2) {
      await admin.auth.admin.deleteUser(creado.user.id); // no dejar cuentas a medias
      return error(e2.message);
    }
    return NextResponse.json({ ok: true, user_id: creado.user.id });
  }

  if (b.accion === "actualizar") {
    if (!b.user_id) return error("Falta el usuario.");
    const p: Record<string, unknown> = { user_id: b.user_id };
    for (const k of ["nombre", "rol", "activo", "sucursales"] as const) if (b[k] !== undefined) p[k] = b[k];
    const { error: e1 } = await sb.rpc("guardar_usuario", { p });
    if (e1) return error(e1.message);

    const cuenta: { password?: string; ban_duration?: string } = {};
    if (b.contrasena) cuenta.password = b.contrasena;
    if (b.activo !== undefined) cuenta.ban_duration = b.activo ? "none" : BLOQUEO;
    if (Object.keys(cuenta).length) {
      const { error: e2 } = await admin.auth.admin.updateUserById(b.user_id, cuenta);
      if (e2) return error(e2.message);
    }
    return NextResponse.json({ ok: true });
  }

  return error("Acción no válida.");
}
