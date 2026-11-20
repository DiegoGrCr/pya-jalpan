/**
 * Descarga una hoja de cálculo de Google (compartida "Cualquier persona con el enlace · Lector")
 * como .xlsx con todas sus pestañas, para leer el inventario de un almacén.
 * Solo usuarios con sesión; solo hojas de docs.google.com (por identificador, no por URL libre).
 */
import { NextResponse } from "next/server";
import { supabaseServidor } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const ID_VALIDO = /^[A-Za-z0-9_-]{20,100}$/;

export async function GET(req: Request) {
  const sb = await supabaseServidor();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return NextResponse.json({ error: "Inicia sesión de nuevo." }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!ID_VALIDO.test(id)) return NextResponse.json({ error: "Enlace de hoja no válido." }, { status: 400 });

  const r = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`, { redirect: "follow", cache: "no-store" });
  const tipo = r.headers.get("content-type") ?? "";
  if (!r.ok || tipo.includes("text/html")) {
    // Google responde con una página de inicio de sesión cuando la hoja no está compartida por enlace
    return NextResponse.json({ error: "No se pudo leer la hoja. Revisa que esté compartida como «Cualquier persona con el enlace» · Lector." }, { status: 502 });
  }
  return new NextResponse(await r.arrayBuffer(), {
    headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "cache-control": "no-store" },
  });
}
