/** Pantalla de las funciones que esperan el timbrado (PAC por elegir). Ver docs/plan.md §6. */
import Link from "next/link";

export default function PendienteTimbrado({ titulo, que }: { titulo: string; que: string }) {
  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4 max-w-2xl">
      <h1 className="text-xl font-semibold">{titulo}</h1>
      <div className="rounded-md border border-amber-200 bg-amber-50 text-amber-900 p-4 text-sm flex flex-col gap-2">
        <p><b>Pendiente de conectar el timbrado.</b> {que}</p>
        <p>Falta elegir con qué proveedor (PAC) se van a timbrar las facturas. Mientras tanto se siguen haciendo como hasta ahora.</p>
      </div>
      <div className="text-sm flex flex-col gap-1">
        <span className="text-[var(--tenue)]">Mientras tanto te pueden servir:</span>
        <Link className="underline" href="/reportes/contable">Resumen contable</Link>
        <Link className="underline" href="/finanzas/cuentas-por-cobrar">Cuentas por cobrar</Link>
        <Link className="underline" href="/ventas/lista">Lista de ventas</Link>
      </div>
    </div>
  );
}
