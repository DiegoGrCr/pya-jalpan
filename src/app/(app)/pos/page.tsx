"use client";
/**
 * Punto de venta.
 * - Búsqueda por nombre/SKU/código de barras (F2). Enter agrega el primer resultado.
 * - Cada partida: unidad de venta con su precio y equivalencia en unidad base.
 * - Calculadora: m² requeridos -> unidades completas.
 * - Cobro mixto con cambio (F8). Confirmación en una sola RPC idempotente.
 * - Sin modo offline: si se cae la conexión avisa y conserva el carrito en este equipo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { supabase, mensajeError } from "@/lib/supabase/client";
import {
  ProductoVenta, UnidadVenta, aBase, calcularPartida, cantidadValida, equivalencia, fmtCantidad, mxn, mxnPrecio, unidadesNecesarias,
} from "@/lib/unidades";

interface Linea {
  uid: string;
  producto: ProductoVenta;
  unidadId: string;
  cantidad: string;
  precio: string;
  descuento: string;
  entregarAhora: boolean;
}
interface Pago { forma: "efectivo" | "tarjeta_debito" | "tarjeta_credito" | "transferencia"; importe: string; referencia: string }
interface Carrito { idempotencyKey: string; lineas: Linea[]; clienteId: string | null; tipo: "contado" | "credito"; cotizacionId: string | null }

interface FilaUnidad { id: string; nombre: string; factor: string; es_base: boolean; orden: number; precios?: { precio: string; lista_id: string }[] }
interface FilaProducto extends Omit<ProductoVenta, "unidades"> { unidades_venta: FilaUnidad[] }
interface FilaContexto { sucursal_id: string; sucursales: { almacenes: { id: string }[] } | null }
interface FilaExistencia { producto_id: string; cantidad: string; apartado: string }

const CARRITO_KEY = "pos-carrito-v1";
const nuevoCarrito = (): Carrito => ({ idempotencyKey: crypto.randomUUID(), lineas: [], clienteId: null, tipo: "contado", cotizacionId: null });
const FORMAS: Record<Pago["forma"], string> = {
  efectivo: "Efectivo", tarjeta_debito: "Tarjeta de débito", tarjeta_credito: "Tarjeta de crédito", transferencia: "Transferencia",
};

function leerCarrito(): Carrito {
  try { const s = localStorage.getItem(CARRITO_KEY); if (s) return JSON.parse(s); } catch { /* sin almacenamiento */ }
  return nuevoCarrito();
}

export default function PuntoDeVenta() {
  const [carrito, setCarrito] = useState<Carrito>(nuevoCarrito);
  const [busqueda, setBusqueda] = useState("");
  const [resultados, setResultados] = useState<ProductoVenta[]>([]);
  const [enLinea, setEnLinea] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exito, setExito] = useState<{ id: string; folio: string; cambio: number; avisos: { producto: string; faltante_base: number }[] } | null>(null);
  const [cobrando, setCobrando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [pagos, setPagos] = useState<Pago[]>([{ forma: "efectivo", importe: "", referencia: "" }]);
  const [ctx, setCtx] = useState<{ sucursalId: string; almacenId: string; listaId: string; incluyeImpuestos: boolean } | null>(null);
  const [existencias, setExistencias] = useState<Record<string, number>>({});
  const buscarRef = useRef<HTMLInputElement>(null);

  // Carrito persistente en este equipo
  useEffect(() => { setCarrito(leerCarrito()); }, []);
  useEffect(() => { try { localStorage.setItem(CARRITO_KEY, JSON.stringify(carrito)); } catch { /* ignorar */ } }, [carrito]);

  // Estado de conexión
  useEffect(() => {
    const on = () => setEnLinea(true), off = () => setEnLinea(false);
    setEnLinea(navigator.onLine);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  // Contexto: primera sucursal/almacén del usuario y lista predeterminada
  useEffect(() => {
    (async () => {
      try {
        const sb = supabase();
        const { data: us } = await sb.from("usuario_sucursales").select("sucursal_id, sucursales(almacenes(id))").limit(1).maybeSingle();
        const { data: lista } = await sb.from("listas_precios").select("id, incluye_impuestos").eq("predeterminada", true).maybeSingle();
        const almacenId = (us as FilaContexto | null)?.sucursales?.almacenes?.[0]?.id;
        if (us && lista && almacenId) setCtx({ sucursalId: us.sucursal_id, almacenId, listaId: lista.id, incluyeImpuestos: lista.incluye_impuestos });
        else setError("Tu usuario no tiene sucursal asignada o no hay lista de precios predeterminada.");
      } catch (e) { setError(mensajeError(e)); }
    })();
  }, []);

  // Atajos de teclado
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); buscarRef.current?.focus(); }
      if (e.key === "F8") { e.preventDefault(); if (carrito.lineas.length) setCobrando(true); }
      if (e.key === "Escape") { setCobrando(false); setResultados([]); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [carrito.lineas.length]);

  const precioDe = useCallback((u: UnidadVenta & { precios?: { precio: string; lista_id: string }[] }) =>
    u.precios?.find((p) => p.lista_id === ctx?.listaId)?.precio ?? null, [ctx]);

  const buscar = useCallback(async (texto: string) => {
    if (!ctx || texto.trim().length < 2) { setResultados([]); return; }
    try {
      const t = texto.trim().replace(/[%,()]/g, "");
      const sel = "id, sku, nombre, unidad_base, permite_fraccion, iva_tasa, ieps_tasa, tipo, codigo_barras, unidades_venta(id, nombre, factor, es_base, codigo_barras, orden, precios(precio, lista_id))";
      const { data, error } = await supabase().from("productos").select(sel).eq("activo", true)
        .or(`sku.ilike.%${t}%,nombre.ilike.%${t}%,codigo_barras.eq.${t}`).limit(15);
      if (error) throw error;
      // Código de barras de una unidad de venta
      let porUnidad: FilaProducto[] = [];
      if (/^\d{6,}$/.test(t)) {
        const r = await supabase().from("unidades_venta").select(`producto_id, productos(${sel})`).eq("codigo_barras", t).limit(1);
        porUnidad = ((r.data ?? []) as unknown as { productos: FilaProducto }[]).map((x) => x.productos);
      }
      const filas = [...porUnidad, ...((data ?? []) as unknown as FilaProducto[])];
      const prods: ProductoVenta[] = filas.map(({ unidades_venta, ...p }) => ({
        ...p,
        unidades: [...unidades_venta].sort((a, b) => a.orden - b.orden).map((u) => ({ ...u, precio: precioDe(u) })),
      }));
      setResultados(prods);
      const ids = prods.map((p) => p.id);
      if (ids.length) {
        const ex = await supabase().from("existencias").select("producto_id, cantidad, apartado").eq("almacen_id", ctx.almacenId).in("producto_id", ids);
        const filasEx = (ex.data ?? []) as FilaExistencia[];
        setExistencias((prev) => ({ ...prev, ...Object.fromEntries(filasEx.map((e) => [e.producto_id, Number(e.cantidad) - Number(e.apartado)])) }));
      }
      setEnLinea(true);
    } catch (e) { setError(mensajeError(e)); }
  }, [ctx, precioDe]);

  useEffect(() => { const t = setTimeout(() => buscar(busqueda), 250); return () => clearTimeout(t); }, [busqueda, buscar]);

  const agregar = (p: ProductoVenta, unidadId?: string) => {
    const u = p.unidades.find((x) => x.id === unidadId) ?? p.unidades.find((x) => !x.es_base) ?? p.unidades[0];
    setCarrito((c) => ({
      ...c,
      lineas: [...c.lineas, { uid: crypto.randomUUID(), producto: p, unidadId: u.id, cantidad: "1", precio: u.precio ?? "0", descuento: "0", entregarAhora: true }],
    }));
    setBusqueda(""); setResultados([]); buscarRef.current?.focus();
  };

  const actualizar = (uid: string, cambios: Partial<Linea>) =>
    setCarrito((c) => ({ ...c, lineas: c.lineas.map((l) => (l.uid === uid ? { ...l, ...cambios } : l)) }));

  const cambiarUnidad = (l: Linea, unidadId: string) => {
    const u = l.producto.unidades.find((x) => x.id === unidadId)!;
    actualizar(l.uid, { unidadId, precio: u.precio ?? "0" });
  };

  const calculadora = (l: Linea) => {
    const u = l.producto.unidades.find((x) => x.id === l.unidadId)!;
    const req = prompt(`¿Cuántos ${l.producto.unidad_base} necesita el cliente?`);
    if (!req || isNaN(Number(req))) return;
    const r = unidadesNecesarias(req, u, l.producto.permite_fraccion);
    actualizar(l.uid, { cantidad: r.unidades.toString() });
  };

  const importes = useMemo(() => carrito.lineas.map((l) => {
    try {
      return calcularPartida(l.cantidad || 0, l.precio || 0, l.descuento || 0, "0", l.producto.ieps_tasa, !!ctx?.incluyeImpuestos); // remisión sin IVA
    } catch { return null; }
  }), [carrito.lineas, ctx]);

  const total = importes.reduce((s, i) => s.plus(i?.total ?? 0), new Decimal(0));
  const subtotal = importes.reduce((s, i) => s.plus(i?.subtotal ?? 0), new Decimal(0));
  const impuestos = total.minus(subtotal);
  const pagoAutomatico = carrito.tipo === "contado" && pagos.length === 1 && !pagos[0].importe;
  const pagosAplicados = pagoAutomatico ? [{ ...pagos[0], importe: total.toFixed(2) }] : pagos;
  const pagado = pagosAplicados.reduce((s, p) => s.plus(p.importe || 0), new Decimal(0));
  const cambio = Decimal.max(pagado.minus(total), 0);
  const lineasInvalidas = carrito.lineas.filter((l) => !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion));

  const confirmar = async () => {
    if (!ctx || enviando) return;
    setEnviando(true); setError(null);
    try {
      const { data, error } = await supabase().rpc("confirmar_venta", {
        p: {
          idempotency_key: carrito.idempotencyKey,
          sucursal_id: ctx.sucursalId, almacen_id: ctx.almacenId, lista_id: ctx.listaId,
          cliente_id: carrito.clienteId, tipo: carrito.tipo, cotizacion_id: carrito.cotizacionId, sin_iva: true,
          partidas: carrito.lineas.map((l) => ({
            producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad,
            precio_unitario: l.precio, descuento: l.descuento || 0, entregar_ahora: l.entregarAhora,
          })),
          pagos: pagosAplicados.filter((p) => Number(p.importe) > 0).map((p) => ({ forma: p.forma, importe: p.importe, referencia: p.referencia || null })),
        },
      });
      if (error) throw error;
      setExito({ id: data.venta_id, folio: `${data.serie}${data.folio}`, cambio: Number(data.cambio), avisos: data.avisos ?? [] });
      setCarrito(nuevoCarrito()); setPagos([{ forma: "efectivo", importe: "", referencia: "" }]); setCobrando(false);
    } catch (e) {
      const m = mensajeError(e);
      if (/conexión/.test(m)) setEnLinea(false);
      setError(m); // el carrito y la clave de idempotencia se conservan: reintentar no duplica
    } finally { setEnviando(false); }
  };

  return (
    <div className="p-4 flex flex-col gap-3 min-h-[calc(100vh-5rem)]">
      {!enLinea && (
        <div role="alert" className="rounded-md bg-red-600 text-white px-4 py-3 font-semibold">
          Sin conexión a internet. No se pueden confirmar ventas. Tu carrito se conserva en este equipo; reintenta al volver la conexión.
        </div>
      )}
      {error && <div role="alert" className="rounded-md bg-amber-100 text-amber-900 px-4 py-2">{error}</div>}
      {exito && (
        <div className="rounded-md bg-emerald-100 text-emerald-900 px-4 py-3">
          Venta <b>{exito.folio}</b> confirmada. Cambio: <b>{mxn(exito.cambio)}</b> · <a className="underline font-semibold" href={`/ventas/${exito.id}`}>Ver nota: imprimir, PDF, enviar</a>
          {exito.avisos.length > 0 && (
            <ul className="mt-1 text-sm list-disc pl-5">
              {exito.avisos.map((a, i) => <li key={i}>{a.producto}: vendida sin existencia ({fmtCantidad(a.faltante_base)} faltante)</li>)}
            </ul>
          )}
        </div>
      )}

      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Punto de venta</h1>
      </header>

      <div className="relative">
        <input
          ref={buscarRef} autoFocus value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && resultados[0]) agregar(resultados[0]); }}
          placeholder="Buscar por nombre, SKU o escanear código de barras…"
          className="w-full rounded-md border px-3 py-2 text-lg bg-[var(--panel)]"
        />
        {resultados.length > 0 && (
          <ul className="absolute z-10 mt-1 w-full rounded-md border bg-[var(--panel)] shadow max-h-80 overflow-auto">
            {resultados.map((p) => (
              <li key={p.id} className="px-3 py-2 hover:bg-[var(--resalte)] cursor-pointer flex justify-between" onClick={() => agregar(p)}>
                <span><b>{p.sku}</b> · {p.nombre}</span>
                <span className="text-sm opacity-80">
                  Exist.: {fmtCantidad(existencias[p.id] ?? 0)} {p.unidad_base}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left opacity-80">
            <tr><th>Producto</th><th>Unidad</th><th>Cantidad</th><th>Equivalencia</th><th>Precio</th><th>Desc.</th><th className="text-right">Importe</th><th></th></tr>
          </thead>
          <tbody>
            {carrito.lineas.map((l, i) => {
              const u = l.producto.unidades.find((x) => x.id === l.unidadId)!;
              const ex = existencias[l.producto.id];
              const sinExistencia = l.producto.tipo === "producto" && ex !== undefined && aBase(l.cantidad || 0, u.factor).gt(ex);
              const invalida = !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion);
              return (
                <tr key={l.uid} className="border-t">
                  <td className="py-2">
                    {l.producto.nombre}
                    {sinExistencia && <div className="text-xs text-red-600">Sin existencia suficiente: se venderá con aviso</div>}
                  </td>
                  <td>
                    <select value={l.unidadId} onChange={(e) => cambiarUnidad(l, e.target.value)} className="border rounded px-1 py-1 bg-[var(--panel)]">
                      {l.producto.unidades.map((x) => <option key={x.id} value={x.id}>{x.nombre} {x.precio ? `· ${mxnPrecio(x.precio)}` : ""}</option>)}
                    </select>
                  </td>
                  <td>
                    <input value={l.cantidad} inputMode="decimal" onChange={(e) => actualizar(l.uid, { cantidad: e.target.value })}
                      className={`w-20 border rounded px-1 py-1 bg-[var(--panel)] ${invalida ? "border-red-600" : ""}`} />
                    <button type="button" onClick={() => calculadora(l)} title={`Calcular desde ${l.producto.unidad_base}`} className="ml-1 text-xs underline">
                      {l.producto.unidad_base}→{u.nombre}
                    </button>
                    {invalida && <div className="text-xs text-red-600">Solo {u.nombre} completas</div>}
                  </td>
                  <td className="whitespace-nowrap">{equivalencia(l.cantidad || 0, u, l.producto.unidad_base)}</td>
                  <td><input value={l.precio} onChange={(e) => actualizar(l.uid, { precio: e.target.value })} className="w-24 border rounded px-1 py-1 bg-[var(--panel)]" /></td>
                  <td><input value={l.descuento} onChange={(e) => actualizar(l.uid, { descuento: e.target.value })} className="w-16 border rounded px-1 py-1 bg-[var(--panel)]" /></td>
                  <td className="text-right">{importes[i] ? mxn(importes[i]!.total) : "—"}</td>
                  <td>
                    <label className="text-xs mr-2"><input type="checkbox" checked={l.entregarAhora} onChange={(e) => actualizar(l.uid, { entregarAhora: e.target.checked })} /> Entrega ahora</label>
                    <button onClick={() => setCarrito((c) => ({ ...c, lineas: c.lineas.filter((x) => x.uid !== l.uid) }))} aria-label="Quitar" className="text-red-600">✕</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {carrito.lineas.length === 0 && <p className="py-8 text-center opacity-60">Escanea o busca un producto para comenzar.</p>}
      </div>

      <footer className="mt-auto flex flex-wrap items-end justify-between gap-4 border-t pt-3">
        <div className="flex gap-2 items-center">
          <label>Tipo:</label>
          <select value={carrito.tipo} onChange={(e) => setCarrito((c) => ({ ...c, tipo: e.target.value as Carrito["tipo"] }))} className="border rounded px-2 py-1 bg-[var(--panel)]">
            <option value="contado">Contado</option><option value="credito">Crédito</option>
          </select>
          <button onClick={() => { if (confirm("¿Vaciar el carrito?")) setCarrito(nuevoCarrito()); }} className="text-sm underline">Vaciar</button>
        </div>
        <div className="text-right">
          <div className="text-sm opacity-80">Subtotal {mxn(subtotal)} · Impuestos {mxn(impuestos)}</div>
          <div className="text-3xl font-bold">{mxn(total)}</div>
          <button disabled={!carrito.lineas.length || lineasInvalidas.length > 0} onClick={() => setCobrando(true)}
            className="mt-2 rounded-md bg-emerald-600 text-white px-6 py-2 text-lg disabled:opacity-40" title="F8">Cobrar</button>
        </div>
      </footer>

      {cobrando && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal>
          <div className="bg-[var(--panel)] rounded-lg p-5 w-full max-w-lg flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Cobro · {mxn(total)}</h2>
            {pagos.map((p, i) => (
              <div key={i} className="flex gap-2">
                <select value={p.forma} onChange={(e) => setPagos((ps) => ps.map((x, j) => (j === i ? { ...x, forma: e.target.value as Pago["forma"] } : x)))} className="border rounded px-2 bg-[var(--panel)]">
                  {Object.entries(FORMAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
                <input autoFocus={i === 0} inputMode="decimal" placeholder={pagoAutomatico && i === 0 ? `${total.toFixed(2)} (total)` : "Importe"} value={p.importe}
                  onChange={(e) => setPagos((ps) => ps.map((x, j) => (j === i ? { ...x, importe: e.target.value } : x)))} className="flex-1 border rounded px-2 py-1 bg-[var(--panel)]" />
                {p.forma !== "efectivo" && (
                  <input placeholder="Referencia" value={p.referencia} onChange={(e) => setPagos((ps) => ps.map((x, j) => (j === i ? { ...x, referencia: e.target.value } : x)))} className="w-32 border rounded px-2 bg-[var(--panel)]" />
                )}
              </div>
            ))}
            <button className="self-start text-sm underline" onClick={() => setPagos((ps) => [...ps, { forma: "tarjeta_debito", importe: total.minus(pagado).gt(0) ? total.minus(pagado).toFixed(2) : "", referencia: "" }])}>+ Agregar otra forma de pago</button>
            <div className="flex justify-between text-lg"><span>Pagado</span><b>{mxn(pagado)}</b></div>
            <div className="flex justify-between text-lg"><span>Cambio</span><b>{mxn(cambio)}</b></div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCobrando(false)} className="px-4 py-2" title="Esc">Cancelar</button>
              <button disabled={enviando || !enLinea || (carrito.tipo === "contado" && pagado.lt(total))} onClick={confirmar}
                className="rounded-md bg-emerald-600 text-white px-5 py-2 disabled:opacity-40">{enviando ? "Confirmando…" : "Confirmar venta"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
