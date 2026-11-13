import Link from "next/link";

const accesos = [
  { href: "/ventas/capturar", titulo: "Capturar venta", detalle: "Nota de venta con caja, pieza o m², pagos mixtos" },
  { href: "/pos", titulo: "Punto de venta", detalle: "Venta rápida con lector de código de barras" },
  { href: "/configuracion/sucursales", titulo: "Sucursales", detalle: "Alta de sucursales, almacenes y series de folios" },
  { href: "/compras/productos", titulo: "Productos", detalle: "En construcción" },
  { href: "/ventas/clientes", titulo: "Clientes", detalle: "En construcción" },
  { href: "/ventas/cotizaciones", titulo: "Cotizaciones", detalle: "En construcción" },
];

export default function Inicio() {
  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-2xl font-semibold mb-4">Inicio</h1>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 max-w-5xl">
        {accesos.map((a) => (
          <Link key={a.href} href={a.href} className="rounded-md bg-[var(--panel)] p-4 border border-[var(--borde)] hover:border-[var(--acento)]">
            <div className="font-semibold" style={{ color: "var(--acento)" }}>{a.titulo}</div>
            <div className="text-sm text-[var(--tenue)]">{a.detalle}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
