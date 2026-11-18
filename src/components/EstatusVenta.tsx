/**
 * Etiquetas de estatus de una venta, iguales en lista, detalle y reporte:
 *   Cancelada  |  Pagada / Con saldo  ·  Abierta / Cerrada  ·  Por entregar
 * "Pagada · Abierta" = ya pagó pero falta cerrarla; "Pagada · Cerrada" = terminada.
 */
const base = "inline-block px-1.5 rounded text-xs whitespace-nowrap";

export default function EstatusVenta({ estado, saldo, cerrada, porEntregar }: {
  estado: string; saldo: string | number; cerrada?: boolean | null; porEntregar?: boolean;
}) {
  if (estado === "cancelada") return <span className={`${base} text-white`} style={{ background: "var(--peligro)" }}>Cancelada</span>;
  const pagada = !(Number(saldo) > 0);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {pagada
        ? <span className={`${base} bg-emerald-100 text-emerald-900`} title="No tiene saldo pendiente">Pagada</span>
        : <span className={`${base} bg-amber-100 text-amber-900`} title="Tiene saldo pendiente de pago">Con saldo</span>}
      {cerrada != null && (cerrada
        ? <span className={`${base} bg-slate-200 text-slate-800`} title="Venta terminada: ya no se edita">Cerrada</span>
        : <span className={`${base} bg-sky-100 text-sky-900`} title={pagada ? "Ya está pagada: falta cerrarla" : "Se puede editar"}>Abierta</span>)}
      {porEntregar && <span className={`${base} bg-orange-100 text-orange-900`} title="Tiene material por entregar">Por entregar</span>}
    </span>
  );
}
