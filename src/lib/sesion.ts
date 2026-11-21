"use client";
/**
 * Una sola sesión abierta por usuario (migración 0049).
 * Cada navegador guarda un identificador de sesión; al entrar se "toma" la sesión y luego se
 * renueva cada minuto. Si el usuario ya está abierto en otro equipo, se rechaza la entrada.
 */
import { supabase } from "@/lib/supabase/client";

const CLAVE = "erp.sesion";
export const LATIDO_MS = 60_000;

export type EstadoSesion =
  | { estado: "ok" }
  | { estado: "ocupada"; equipo?: string | null; desde?: string | null }
  | { estado: "revocada" }
  | { estado: "sin-migracion" };

function leer(): string | null { try { return localStorage.getItem(CLAVE); } catch { return null; } }
function guardar(v: string | null) { try { if (v) localStorage.setItem(CLAVE, v); else localStorage.removeItem(CLAVE); } catch { /* sin almacenamiento */ } }

/** "Chrome en Windows", "Safari en iPhone"… para que se sepa dónde quedó abierta */
export function equipoActual(): string {
  const ua = navigator.userAgent;
  const nav = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Navegador";
  const so = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "otro equipo";
  return `${nav} en ${so}`;
}

/** crypto.randomUUID solo existe en https/localhost; respaldo para otros casos */
function nuevoId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}

const faltaMigracion = (m: string) => /tomar_sesion|sesiones_activas/.test(m) && /exist|could not find|schema cache/i.test(m);

async function tomar(id: string): Promise<EstadoSesion> {
  const { data, error } = await supabase().rpc("tomar_sesion", { p: { sesion: id, equipo: equipoActual() } });
  if (error) {
    if (faltaMigracion(error.message)) return { estado: "sin-migracion" };
    throw error;
  }
  return data as EstadoSesion;
}

/** Al iniciar sesión: siempre un identificador nuevo */
export async function iniciarSesionUnica(): Promise<EstadoSesion> {
  const id = nuevoId();
  const r = await tomar(id);
  guardar(r.estado === "ok" ? id : null);
  return r;
}

/** Latido: mantiene viva la sesión de este navegador (o la toma si aún no tenía, p. ej. sesiones de antes de la 0049) */
export async function latirSesion(): Promise<EstadoSesion> {
  let id = leer();
  if (!id) id = nuevoId();
  const r = await tomar(id);
  guardar(r.estado === "ok" ? id : null);
  return r;
}

/** Al salir: libera la sesión para poder entrar desde otro equipo de inmediato */
export async function dejarSesion(): Promise<void> {
  const id = leer();
  guardar(null);
  if (id) await supabase().rpc("dejar_sesion", { p: { sesion: id } }).then(() => undefined, () => undefined);
}

/** Cierra la sesión de Supabase solo en este navegador (sin tocar la del otro equipo) */
export async function salirLocal(): Promise<void> {
  await supabase().auth.signOut({ scope: "local" });
}

export function mensajeOcupada(r: { equipo?: string | null; desde?: string | null }): string {
  const donde = r.equipo ? ` (${r.equipo}` + (r.desde ? `, desde las ${new Date(r.desde).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone: "America/Mexico_City" })})` : ")") : "";
  return `Este usuario ya tiene una sesión abierta en otro equipo${donde}. Ciérrala allá (botón con tus iniciales, arriba a la derecha), `
    + "o si el equipo se apagó, espera 3 minutos o pide a un administrador que la cierre en Configuración › Usuarios.";
}
