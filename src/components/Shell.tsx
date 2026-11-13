"use client";
/**
 * Estructura común: barra superior + menú lateral por módulos + ruta (breadcrumb).
 * Los módulos siguen el mismo orden que usa el personal hoy:
 * Inicio · Compras · Inventarios · Ventas · Finanzas · Créditos · Reportes · Configuración.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

interface Item { texto: string; href: string }
interface Grupo { texto: string; icono: string; href?: string; items?: Item[] }

export const MENU: Grupo[] = [
  { texto: "Inicio", icono: "⌂", href: "/" },
  { texto: "Compras", icono: "🛒", items: [
    { texto: "Productos", href: "/compras/productos" },
    { texto: "Proveedores", href: "/compras/proveedores" },
  ] },
  { texto: "Inventarios", icono: "▤", items: [
    { texto: "Almacenes y existencias", href: "/inventarios/existencias" },
    { texto: "Recepción de mercancía", href: "/inventarios/recepcion" },
    { texto: "Traspasos", href: "/inventarios/traspasos" },
    { texto: "Ajustes y conteo", href: "/inventarios/ajustes" },
  ] },
  { texto: "Ventas", icono: "$", items: [
    { texto: "Clientes", href: "/ventas/clientes" },
    { texto: "Cotizaciones", href: "/ventas/cotizaciones" },
    { texto: "Apartados", href: "/ventas/apartados" },
    { texto: "Capturar venta", href: "/ventas/capturar" },
    { texto: "Punto de venta", href: "/pos" },
  ] },
  { texto: "Finanzas", icono: "≡", items: [
    { texto: "Cuentas por cobrar", href: "/finanzas/cuentas-por-cobrar" },
    { texto: "Pagos de clientes", href: "/finanzas/pagos" },
    { texto: "Corte de caja", href: "/finanzas/corte" },
  ] },
  { texto: "Créditos", icono: "▭", items: [
    { texto: "Estado de cuenta de clientes", href: "/creditos/estado-de-cuenta" },
    { texto: "Facturar ventas", href: "/creditos/facturar" },
    { texto: "Notas de crédito", href: "/creditos/notas-de-credito" },
  ] },
  { texto: "Reportes", icono: "▥", items: [
    { texto: "Ventas", href: "/reportes/ventas" },
    { texto: "Inventarios", href: "/reportes/inventarios" },
    { texto: "Cobranza", href: "/reportes/cobranza" },
  ] },
  { texto: "Configuración", icono: "⚙", items: [
    { texto: "Empresa y documentos", href: "/configuracion/empresa" },
    { texto: "Sucursales", href: "/configuracion/sucursales" },
    { texto: "Usuarios", href: "/configuracion/usuarios" },
  ] },
];

/** Texto de la ruta para el breadcrumb: "Ventas › Capturar venta" */
export function rutaDe(path: string): string[] {
  for (const g of MENU) {
    if (g.href === path) return [g.texto];
    const it = g.items?.find((i) => path === i.href || path.startsWith(i.href + "/"));
    if (it) return [g.texto, it.texto];
  }
  return [];
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [usuario, setUsuario] = useState<string>("");
  const [abierto, setAbierto] = useState<string | null>(() => rutaDe(path)[0] ?? null);
  const [menuMovil, setMenuMovil] = useState(false);

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data } = await sb.from("perfiles").select("nombre").eq("user_id", user.id).maybeSingle();
      setUsuario(data?.nombre ?? user.email ?? "");
    })();
  }, []);

  useEffect(() => { setMenuMovil(false); }, [path]);

  const salir = async () => { await supabase().auth.signOut(); router.replace("/login"); router.refresh(); };
  const ruta = rutaDe(path);
  const iniciales = usuario.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="h-12 flex items-center gap-3 px-3 text-white" style={{ background: "var(--barra)" }}>
        <button className="sm:hidden text-xl" onClick={() => setMenuMovil((v) => !v)} aria-label="Menú">☰</button>
        <Link href="/" className="font-semibold tracking-wide">[NOMBRE]</Link>
        <span className="flex-1 truncate text-lg">{usuario}</span>
        <Link href="/ventas/capturar" title="Capturar venta" className="text-xl">＋</Link>
        <button onClick={salir} title="Cerrar sesión"
          className="w-8 h-8 rounded-full grid place-items-center text-sm font-semibold" style={{ background: "var(--acento)" }}>
          {iniciales || "?"}
        </button>
      </header>
      <div className="h-8 flex items-center px-4 text-sm text-white" style={{ background: "var(--acento)" }}>
        {ruta.length ? ruta.map((r, i) => <span key={i}>{i > 0 && " › "}{r}</span>) : "Inicio"}
      </div>

      <div className="flex flex-1 min-h-0">
        <nav
          className={`${menuMovil ? "block" : "hidden"} sm:block w-56 shrink-0 text-sm absolute sm:static z-20 h-[calc(100vh-5rem)] sm:h-auto overflow-y-auto`}
          style={{ background: "var(--menu)", color: "var(--menu-texto)" }}
        >
          {MENU.map((g) => {
            const activo = ruta[0] === g.texto;
            const contenido = (
              <span className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-4 text-center opacity-80">{g.icono}</span>{g.texto}
              </span>
            );
            return (
              <div key={g.texto}>
                {g.href ? (
                  <Link href={g.href} style={activo ? { background: "var(--menu-activo)" } : undefined} className="block hover:bg-white/5">{contenido}</Link>
                ) : (
                  <button onClick={() => setAbierto(abierto === g.texto ? null : g.texto)}
                    style={activo ? { background: "var(--menu-activo)" } : undefined}
                    className="w-full text-left hover:bg-white/5" aria-expanded={abierto === g.texto}>
                    {contenido}
                  </button>
                )}
                {g.items && abierto === g.texto && (
                  <div style={{ background: "#e9edf1", color: "var(--texto)" }}>
                    {g.items.map((it) => (
                      <Link key={it.href} href={it.href}
                        className={`block pl-9 pr-3 py-2 hover:bg-white ${path.startsWith(it.href) ? "font-semibold bg-white" : ""}`}>
                        » {it.texto}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <main className="flex-1 min-w-0 overflow-x-hidden">{children}</main>
      </div>
    </div>
  );
}
