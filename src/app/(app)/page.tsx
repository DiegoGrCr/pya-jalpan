"use client";
/**
 * Inicio (tablero): Resumen general y Ventas, con histórico de ventas y de cobros por mes,
 * ingresos del periodo, capital de trabajo, ventas por categoría y productos más vendidos.
 * Cada usuario ve solo sus sucursales.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";
import { nombresUsuarios } from "@/lib/documentoVenta";
import GraficaBarras from "@/components/GraficaBarras";

interface Tablero {
  desde: string; hasta: string;
  ventas_mes: { mes: string; total: number; ventas: number }[];
  cobros_mes: { mes: string; cobrado: number; devuelto: number }[];
  periodo: { ventas_total: number; num_ventas: number; descuentos: number; cobrado: number; devoluciones: number; por_cerrar: number };
  capital: { cxc: number; cxc_vencida: number; num_con_saldo: number; inventario: number; saldo_favor: number };
  categorias: { categoria: string; total: number }[];
  productos: { sku: string; nombre: string; formato: string | null; m2_por_caja: number | null; total: number; cantidad_base: number; m2: number | null }[];
  sucursales: { sucursal: string; total: number; ventas: number }[];
  vendedores: { vendedor_id: string | null; total: number; ventas: number }[];
}

const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const inicioMes = () => `${hoy().slice(0, 8)}01`;
const $ = (n: number | string) => `$${fmtImporte(Number(n))}`;
const mesCorto = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleDateString("es-MX", { month: "short", year: "2-digit" }).replace(".", "");
const RANGOS = [1, 3, 6, 12, 24];

const accesos = [
  { href: "/ventas/capturar", titulo: "Capturar venta" }, { href: "/pos", titulo: "Punto de venta" },
  { href: "/ventas/lista", titulo: "Lista de ventas" }, { href: "/compras/productos", titulo: "Productos" },
  { href: "/reportes/ventas", titulo: "Reporte de ventas" },
];

export default function Inicio() {
  const [pestana, setPestana] = useState<"resumen" | "ventas">("resumen");
  const [desde, setDesde] = useState(inicioMes());
  const [hasta, setHasta] = useState(hoy());
  const [sucursal, setSucursal] = useState("");
  const [sucursales, setSucursales] = useState<{ id: string; nombre: string }[]>([]);
  const [t, setT] = useState<Tablero | null>(null);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [meses, setMeses] = useState(12);
  const [mesesFlujo, setMesesFlujo] = useState(12);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales(((data ?? []) as { id: string; codigo: string; nombre: string }[]).map((s) => ({ id: s.id, nombre: `${s.codigo} - ${s.nombre}` }))));
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("tablero", { p: { desde, hasta, sucursal_id: sucursal || null } });
      if (error) {
        if (/tablero/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000031_tablero.sql en Supabase para ver el tablero.");
        throw error;
      }
      const tb = data as Tablero;
      setT(tb);
      const ids = tb.vendedores.map((x) => x.vendedor_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg(mensajeError(e)); } finally { setCargando(false); }
  }, [desde, hasta, sucursal]);

  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ventasMes = useMemo(() => (t?.ventas_mes ?? []).slice(-meses).map((m) => ({
    etiqueta: mesCorto(m.mes), valor: Number(m.total), detalle: `${m.ventas} venta${m.ventas === 1 ? "" : "s"}` })), [t, meses]);
  const flujoMes = useMemo(() => (t?.cobros_mes ?? []).slice(-mesesFlujo).map((m) => ({
    etiqueta: mesCorto(m.mes), valor: Number(m.cobrado) - Number(m.devuelto),
    detalle: Number(m.devuelto) > 0 ? `Cobrado ${$(m.cobrado)} · devuelto ${$(m.devuelto)}` : undefined })), [t, mesesFlujo]);
  const sumaVentas = ventasMes.reduce((s, x) => s + x.valor, 0);
  const sumaFlujo = flujoMes.reduce((s, x) => s + x.valor, 0);

  const Rango = ({ valor, set }: { valor: number; set: (n: number) => void }) => (
    <div className="inline-flex rounded border border-[var(--borde)] overflow-hidden text-sm" role="group" aria-label="Meses a mostrar">
      {RANGOS.map((r) => (
        <button key={r} onClick={() => set(r)} aria-pressed={valor === r}
          className={`px-2.5 py-1 ${valor === r ? "text-white" : "text-[var(--acento)] hover:bg-[var(--resalte)]"}`}
          style={valor === r ? { background: "var(--acento)" } : undefined}>{r}m</button>
      ))}
    </div>
  );
  const Fila = ({ signo, k, v, total }: { signo: string; k: string; v: number; total?: boolean }) => (
    <div className={`flex justify-between px-2 py-1 ${total ? "text-white font-medium" : "odd:bg-[#f4f7f6]"}`} style={total ? { background: "var(--acento)" } : undefined}>
      <span>({signo}) {k}</span><span>{$(v)}</span>
    </div>
  );

  const p = t?.periodo, c = t?.capital;
  const capitalTotal = c ? Number(c.cxc) + Number(c.inventario) - Number(c.saldo_favor) : 0;
  const maxCat = Math.max(1, ...(t?.categorias ?? []).map((x) => Number(x.total)));

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {accesos.map((a) => (
          <Link key={a.href} href={a.href} className="px-3 py-1.5 rounded border border-[var(--borde)] bg-[var(--panel)] text-sm hover:border-[var(--acento)]" style={{ color: "var(--acento)" }}>{a.titulo}</Link>
        ))}
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)]">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--borde)] px-4 pt-3">
          <div className="flex gap-1">
            {(["resumen", "ventas"] as const).map((x) => (
              <button key={x} onClick={() => setPestana(x)}
                className={`px-3 py-2 rounded-t border border-b-0 ${pestana === x ? "border-[var(--borde)] font-semibold" : "border-transparent text-[var(--acento)]"}`}>
                {x === "resumen" ? "Resumen general" : "Ventas"}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-2 pb-2 text-sm">
            <label>Desde<input type="date" className="campo !py-1" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
            <label>Hasta<input type="date" className="campo !py-1" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
            <label>Sucursal
              <select className="campo !py-1" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
                <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}
              </select>
            </label>
            <button className="btn-primario" disabled={cargando} onClick={cargar}>{cargando ? "…" : "Ver"}</button>
          </div>
        </div>

        {msg && <div role="alert" className="m-4 rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}
        {!t && cargando && <div className="p-6 text-[var(--tenue)]">Cargando…</div>}

        {t && p && c && pestana === "resumen" && (
          <div className="grid gap-6 p-4 xl:grid-cols-[1fr_360px]">
            <div className="flex flex-col gap-6 min-w-0">
              <div>
                <div className="flex flex-wrap justify-between items-center gap-2 mb-1">
                  <h2 className="text-lg">Histórico de ventas <span className="font-semibold">{$(sumaVentas)}</span></h2>
                  <Rango valor={meses} set={setMeses} />
                </div>
                <GraficaBarras titulo="Ventas por mes" datos={ventasMes} formato={$} />
              </div>
              <div>
                <div className="flex flex-wrap justify-between items-center gap-2 mb-1">
                  <h2 className="text-lg">Histórico de flujo de efectivo <span className="font-semibold">{$(sumaFlujo)}</span></h2>
                  <Rango valor={mesesFlujo} set={setMesesFlujo} />
                </div>
                <GraficaBarras titulo="Cobrado menos devoluciones por mes" datos={flujoMes} formato={$} />
                <p className="text-xs text-[var(--tenue)]">Lo cobrado en cada mes (pagos y abonos) menos las devoluciones de dinero.</p>
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <div>
                  <h2 className="text-lg mb-2">Ventas por categoría <span className="font-semibold">{$(p.ventas_total)}</span></h2>
                  {t.categorias.length === 0 && <div className="text-sm text-[var(--tenue)]">Sin ventas en el periodo.</div>}
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {t.categorias.slice(0, 8).map((x) => (
                      <li key={x.categoria}>
                        <div className="flex justify-between"><span>{x.categoria}</span><span>{$(x.total)}</span></div>
                        <div className="h-1.5 rounded bg-[var(--resalte)]"><div className="h-1.5 rounded" style={{ width: `${(Number(x.total) / maxCat) * 100}%`, background: "var(--acento)" }} /></div>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h2 className="text-lg mb-2">Cartera</h2>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <Link href="/ventas/lista" className="rounded border border-[var(--borde)] p-3 hover:border-[var(--acento)]">
                      <div className="text-[var(--tenue)]">Por cobrar</div><div className="text-xl font-semibold">{$(c.cxc)}</div>
                      <div className="text-xs text-[var(--tenue)]">{c.num_con_saldo} venta{Number(c.num_con_saldo) === 1 ? "" : "s"} con saldo</div>
                    </Link>
                    <div className="rounded border border-[var(--borde)] p-3">
                      <div className="text-[var(--tenue)]">Vencida (crédito)</div>
                      <div className={`text-xl font-semibold ${Number(c.cxc_vencida) > 0 ? "text-[var(--peligro)]" : ""}`}>{$(c.cxc_vencida)}</div>
                    </div>
                    <Link href="/ventas/lista" className="rounded border border-[var(--borde)] p-3 hover:border-[var(--acento)] col-span-2">
                      <div className="text-[var(--tenue)]">Pagadas sin cerrar (periodo)</div><div className="text-xl font-semibold">{p.por_cerrar}</div>
                    </Link>
                  </div>
                </div>
              </div>
            </div>

            <aside className="text-sm flex flex-col gap-5">
              <div>
                <h2 className="text-base mb-1">Ingresos / egresos del periodo</h2>
                <Fila signo="+" k="Ventas cobradas" v={Number(p.cobrado)} />
                <Fila signo="−" k="Devoluciones" v={Number(p.devoluciones)} />
                <Fila signo="=" k="Total" v={Number(p.cobrado) - Number(p.devoluciones)} total />
                <p className="text-xs text-[var(--tenue)] mt-1">Compras y gastos aparecerán aquí cuando se registren en el sistema.</p>
              </div>
              <div>
                <h2 className="text-base mb-1">Capital de trabajo</h2>
                <Fila signo="+" k="Cuentas por cobrar" v={Number(c.cxc)} />
                <Fila signo="+" k="Valor del inventario" v={Number(c.inventario)} />
                <Fila signo="−" k="Saldo a favor de clientes" v={Number(c.saldo_favor)} />
                <Fila signo="=" k="Total" v={capitalTotal} total />
                {Number(c.inventario) === 0 && <p className="text-xs text-[var(--tenue)] mt-1">El valor del inventario sale del costo de compra; aparecerá al registrar compras.</p>}
              </div>
            </aside>
          </div>
        )}

        {t && p && pestana === "ventas" && (
          <div className="p-4 flex flex-col gap-6">
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
              {[["Ventas del periodo", $(p.ventas_total)], ["Número de ventas", String(p.num_ventas)],
                ["Ticket promedio", $(Number(p.num_ventas) ? Number(p.ventas_total) / Number(p.num_ventas) : 0)], ["Descuentos", $(p.descuentos)]].map(([k, v]) => (
                <div key={k} className="rounded border border-[var(--borde)] p-3">
                  <div className="text-sm text-[var(--tenue)]">{k}</div><div className="text-2xl font-semibold">{v}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h2 className="text-lg mb-2">Productos más vendidos</h2>
                <table className="w-full text-sm">
                  <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                    <th className="font-normal py-1">Producto</th><th className="font-normal text-right">M² / cant.</th><th className="font-normal text-right">Total</th></tr></thead>
                  <tbody>
                    {t.productos.map((x) => (
                      <tr key={x.sku} className="border-b border-[var(--borde)]">
                        <td className="py-1.5 pr-2">{nombreConCaja(x.nombre, x.m2_por_caja, x.formato)}<div className="text-xs text-[var(--tenue)]">{x.sku}</div></td>
                        <td className="text-right pr-2 whitespace-nowrap">{x.m2 ? `${fmtCantidad(x.m2, 2)} m²` : fmtCantidad(x.cantidad_base, 2)}</td>
                        <td className="text-right whitespace-nowrap">{$(x.total)}</td>
                      </tr>
                    ))}
                    {!t.productos.length && <tr><td colSpan={3} className="py-3 text-[var(--tenue)]">Sin ventas en el periodo.</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-col gap-6">
                <div>
                  <h2 className="text-lg mb-2">Por sucursal</h2>
                  <table className="w-full text-sm"><tbody>
                    {t.sucursales.map((x) => (
                      <tr key={x.sucursal} className="border-b border-[var(--borde)]"><td className="py-1.5">{x.sucursal}</td>
                        <td className="text-right text-[var(--tenue)]">{x.ventas} ventas</td><td className="text-right">{$(x.total)}</td></tr>
                    ))}
                  </tbody></table>
                </div>
                <div>
                  <h2 className="text-lg mb-2">Por vendedor (capturó)</h2>
                  <table className="w-full text-sm"><tbody>
                    {t.vendedores.map((x, i) => (
                      <tr key={x.vendedor_id ?? i} className="border-b border-[var(--borde)]"><td className="py-1.5">{(x.vendedor_id && nombres[x.vendedor_id]) || "—"}</td>
                        <td className="text-right text-[var(--tenue)]">{x.ventas} ventas</td><td className="text-right">{$(x.total)}</td></tr>
                    ))}
                  </tbody></table>
                </div>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
