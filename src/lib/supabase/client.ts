"use client";
import { createBrowserClient } from "@supabase/ssr";

let client: ReturnType<typeof createBrowserClient> | null = null;

export function supabase() {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anon = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !anon) {
      throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY en .env.local");
    }
    client = createBrowserClient(url, anon);
  }
  return client;
}

/** Traduce errores de Postgres/RPC a un mensaje claro para el usuario. */
export function mensajeError(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/Failed to fetch|NetworkError|fetch failed/i.test(m)) return "Sin conexión con el servidor. La venta NO se guardó; tu carrito se conserva.";
  if (/permission denied/i.test(m)) return "No tienes permiso para esta operación.";
  return m;
}
