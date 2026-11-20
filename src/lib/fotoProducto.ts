/**
 * Foto del producto (0046): se reduce en el navegador, se sube a Supabase Storage (carpeta "productos")
 * y se guarda el enlace en productos.imagen_url. Solo sirve para identificar el producto; no se imprime.
 */
import { supabase } from "@/lib/supabase/client";

const BUCKET = "productos";
const FALTA = "Falta ejecutar la migración 20261120000046_foto_producto.sql en Supabase.";

/** Reduce la foto (máx. 1200 px por lado) y la convierte a JPEG */
export async function comprimirFoto(archivo: File): Promise<Blob> {
  if (!archivo.type.startsWith("image/")) throw new Error("El archivo no es una imagen.");
  const url = URL.createObjectURL(archivo);
  try {
    const img = await new Promise<HTMLImageElement>((ok, mal) => {
      const i = new Image(); i.onload = () => ok(i); i.onerror = () => mal(new Error("No se pudo leer la imagen.")); i.src = url;
    });
    const k = Math.min(1, 1200 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return await new Promise<Blob>((ok, mal) => c.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo procesar la imagen."))), "image/jpeg", 0.82));
  } finally { URL.revokeObjectURL(url); }
}

/** Ruta dentro de la carpeta a partir del enlace público (null si no es de esta carpeta) */
export function rutaDe(url: string | null | undefined): string | null {
  const m = url?.match(/\/object\/public\/productos\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

const traducir = (e: { message: string }) =>
  /bucket|not found|foto_producto|row-level security|policy/i.test(e.message) ? new Error(FALTA) : e;

/** Sube la foto, la asigna al producto y borra la anterior. Devuelve el enlace nuevo. */
export async function subirFotoProducto(productoId: string, foto: Blob, anterior?: string | null): Promise<string> {
  const sb = supabase();
  const ruta = `${productoId}/${Date.now()}.jpg`;
  const up = await sb.storage.from(BUCKET).upload(ruta, foto, { contentType: "image/jpeg", upsert: false });
  if (up.error) throw traducir(up.error);
  const url = sb.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;
  const r = await sb.rpc("foto_producto", { p: { producto_id: productoId, imagen_url: url } });
  if (r.error) { await sb.storage.from(BUCKET).remove([ruta]); throw traducir(r.error); }
  const vieja = rutaDe(anterior);
  if (vieja) await sb.storage.from(BUCKET).remove([vieja]);   // si falla, solo queda el archivo huérfano
  return url;
}

/** Quita la foto del producto y borra el archivo */
export async function quitarFotoProducto(productoId: string, anterior: string | null | undefined) {
  const sb = supabase();
  const r = await sb.rpc("foto_producto", { p: { producto_id: productoId, imagen_url: null } });
  if (r.error) throw traducir(r.error);
  const vieja = rutaDe(anterior);
  if (vieja) await sb.storage.from(BUCKET).remove([vieja]);
}
