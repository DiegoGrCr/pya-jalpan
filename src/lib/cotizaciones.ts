/** Estatus que se muestra de una cotización: vigente / vencida (por fecha) / convertida en venta / cancelada. */
export function estatusCotizacion(c: { estado: string; vigencia: string | null }) {
  const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
  if (c.estado === "convertida") return { txt: "Convertida en venta", cls: "bg-emerald-100 text-emerald-900" };
  if (c.estado === "cancelada") return { txt: "Cancelada", cls: "text-white", bg: "var(--peligro)" };
  if (c.vigencia && c.vigencia < hoy) return { txt: "Vencida", cls: "bg-amber-100 text-amber-900" };
  return { txt: "Vigente", cls: "bg-sky-100 text-sky-900" };
}
