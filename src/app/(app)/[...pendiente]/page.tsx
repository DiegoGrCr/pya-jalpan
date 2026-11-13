"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { rutaDe } from "@/components/Shell";

/** Pantallas del menú que aún no están construidas. */
export default function Pendiente() {
  const ruta = rutaDe(usePathname());
  return (
    <div className="p-6">
      <div className="bg-[var(--panel)] rounded-md p-6 border border-[var(--borde)] max-w-xl">
        <h1 className="text-xl font-semibold mb-2">{ruta.at(-1) ?? "Pantalla"}</h1>
        <p className="text-[var(--tenue)]">Esta pantalla está en construcción. La base de datos ya está preparada para ella.</p>
        <Link href="/ventas/capturar" className="btn-primario inline-block mt-4">Ir a Capturar venta</Link>
      </div>
    </div>
  );
}
