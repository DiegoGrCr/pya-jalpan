/**
 * Iconos y botones de acción de todo el sistema. Para que se usen siempre los mismos:
 *   Abrir / ver detalle  → IconoAbrir (flecha saliendo del cuadro)
 *   Editar               → IconoEditar (lápiz)
 *   Generar venta        → IconoCarrito
 *   Ver detalle rápido   → IconoVer (ojo; solo dentro de un renglón, p. ej. el producto en la captura)
 * En las listas, las acciones por renglón van con <BotonAccion> (cuadro con borde, solo icono y su título).
 */
import Link from "next/link";

type P = { className?: string };
const svg = { width: 14, height: 14, fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, viewBox: "0 0 24 24", "aria-hidden": true };

export const IconoAbrir = ({ className }: P) => <svg {...svg} className={className}><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>;
export const IconoEditar = ({ className }: P) => <svg {...svg} className={className}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /></svg>;
export const IconoCarrito = ({ className }: P) => (
  <svg {...svg} className={className}><path d="M3 4h2l2.5 11h11L21 7H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm9 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" /></svg>
);
export const IconoVer = ({ className }: P) => <svg {...svg} className={className}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;

const ICONOS = { abrir: IconoAbrir, editar: IconoEditar, venta: IconoCarrito, ver: IconoVer };
const COLOR = { abrir: "border-[var(--acento)] text-[var(--acento)]", editar: "border-[var(--acento)] text-[var(--acento)]", venta: "border-emerald-600 text-emerald-700", ver: "border-[var(--acento)] text-[var(--acento)]" };
const caja = "inline-flex items-center justify-center w-7 h-7 rounded border hover:bg-[var(--resalte)] shrink-0";

/** Botón cuadrado de acción por renglón. Con href es enlace; con onClick, botón. */
export function BotonAccion({ tipo, titulo, href, onClick }: { tipo: keyof typeof ICONOS; titulo: string; href?: string; onClick?: () => void }) {
  const I = ICONOS[tipo];
  const cls = `${caja} ${COLOR[tipo]}`;
  if (href) return <Link href={href} title={titulo} aria-label={titulo} className={cls} onClick={(e) => e.stopPropagation()}><I /></Link>;
  return <button type="button" title={titulo} aria-label={titulo} className={cls} onClick={(e) => { e.stopPropagation(); onClick?.(); }}><I /></button>;
}
