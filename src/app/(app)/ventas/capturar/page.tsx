"use client";
/**
 * Ventas › Capturar venta
 * Distribución familiar para el personal: encabezado (empresa, cliente, sucursal, almacén),
 * partidas (Código · Unidad · Concepto con existencia · Cant. · Precio · Importe),
 * sección Pagos, comentarios y totales a la derecha. Guarda con confirmar_venta (una transacción).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { useRouter } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { ProductoVenta, UnidadVenta, aBase, calcularPartida, cantidadValida, fmtCantidad, medida, unidadesNecesarias } from "@/lib/unidades";

type Forma = "efectivo" | "transferencia" | "tarjeta_debito" | "tarjeta_credito";
const FORMAS: Record<Forma, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta_debito: "Tarjeta de débito", tarjeta_credito: "Tarjeta de crédito",
};

interface Linea { uid: string; producto: ProductoVenta; unidadId: string; cantidad: string; precio: string; descuento: string; entregarAhora: boolean; comentario: string }
interface Pago { forma: Forma; importe: string; referencia: string }
interface Cliente { id: string; nombre: string; rfc: string | null; es_publico_general: boolean; lista_precios_id: string | null; limite_credito: string; dias_credito: number }
interface Almacen { id: string; nombre: string; sucursal_id: string; multisucursal: boolean }
interface Sucursal { id: string; codigo: string; nombre: string; cp_expedicion: string | null }
interface Captura { clave: string; sucursalId: string; almacenId: string; cliente: Cliente | null; tipo: "contado" | "credito"; lineas: Linea[]; pagos: Pago[]; comentarios: string; sinIva?: boolean }

interface FilaUnidad { id: string; nombre: string; factor: string; es_base: boolean; orden: number; precios?: { precio: string; lista_id: string }[] }
interface FilaProducto extends Omit<ProductoVenta, "unidades"> { unidades_venta: FilaUnidad[] }

const CLAVE_LOCAL = "captura-venta-v1";
const pagoInicial = (): Pago[] => [{ forma: "efectivo", importe: "", referencia: "" }];
const capturaNueva = (sucursalId = "", almacenId = "", cliente: Cliente | null = null): Captura =>
  ({ clave: crypto.randomUUID(), sucursalId, almacenId, cliente, tipo: "contado", lineas: [], pagos: pagoInicial(), comentarios: "", sinIva: true });

export default function CapturarVenta() {
  const [sucursales, setSucursales] = useState<Sucursal[]>([]);
  const [almacenes, setAlmacenes] = useState<Almacen[]>([]);
  const [publico, setPublico] = useState<Cliente | null>(null);
  const [lista, setLista] = useState<{ id: string; incluye: boolean } | null>(null);
  const [c, setC] = useState<Captura>(() => capturaNueva());
  const [existencias, setExistencias] = useState<Record<string, number>>({});
  const [buscando, setBuscando] = useState(false);
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<ProductoVenta[]>([]);
  const [textoCliente, setTextoCliente] = useState("");
  const [clientes, setClientes] = useState<Cliente[]>([]);
  const [enLinea, setEnLinea] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string; avisos?: string[] } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const busRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // ---------- carga inicial ----------
  useEffect(() => {
    (async () => {
      try {
        const sb = supabase();
        const { data: { user } } = await sb.auth.getUser();
        const [suc, alm, pub, lp] = await Promise.all([
          sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre, cp_expedicion)").eq("user_id", user!.id),
          sb.from("almacenes").select("id, nombre, sucursal_id, multisucursal").eq("activo", true).order("nombre"),
          sb.from("clientes").select("id, nombre, rfc, es_publico_general, lista_precios_id, limite_credito, dias_credito").eq("es_publico_general", true).maybeSingle(),
          sb.from("listas_precios").select("id, incluye_impuestos").eq("predeterminada", true).maybeSingle(),
        ]);
        const sucs = ((suc.data ?? []) as unknown as { sucursales: Sucursal }[]).map((x) => x.sucursales).filter(Boolean);
        setSucursales(sucs);
        setAlmacenes((alm.data ?? []) as Almacen[]);
        setPublico(pub.data as Cliente);
        if (lp.data) setLista({ id: lp.data.id, incluye: lp.data.incluye_impuestos });
        if (!sucs.length) setMsg({ tipo: "error", texto: "Tu usuario no tiene sucursales asignadas." });

        let guardada: Captura | null = null;
        try { const s = localStorage.getItem(CLAVE_LOCAL); if (s) guardada = JSON.parse(s); } catch { /* sin almacenamiento */ }
        if (guardada && guardada.lineas.length) setC(guardada);
        else {
          const s0 = sucs[0]?.id ?? "";
          const a0 = ((alm.data ?? []) as Almacen[]).find((a) => a.sucursal_id === s0)?.id ?? "";
          setC(capturaNueva(s0, a0, pub.data as Cliente));
        }
      } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    })();
  }, []);

  // La captura se conserva en este equipo hasta guardarla (por si se va la conexión)
  useEffect(() => { try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(c)); } catch { /* ignorar */ } }, [c]);

  useEffect(() => {
    const on = () => setEnLinea(true), off = () => setEnLinea(false);
    setEnLinea(navigator.onLine);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const almacenesSucursal = almacenes.filter((a) => a.sucursal_id === c.sucursalId || a.multisucursal);
  const sucursal = sucursales.find((s) => s.id === c.sucursalId);

  // ---------- existencias del almacén elegido ----------
  const cargarExistencias = useCallback(async (ids: string[], almacenId: string) => {
    if (!ids.length || !almacenId) return;
    const { data } = await supabase().from("existencias").select("producto_id, cantidad, apartado").eq("almacen_id", almacenId).in("producto_id", ids);
    const mapa = Object.fromEntries(ids.map((id) => [id, 0]));
    for (const e of (data ?? []) as { producto_id: string; cantidad: string; apartado: string }[]) mapa[e.producto_id] = Number(e.cantidad) - Number(e.apartado);
    setExistencias((prev) => ({ ...prev, ...mapa }));
  }, []);

  useEffect(() => { cargarExistencias([...new Set(c.lineas.map((l) => l.producto.id))], c.almacenId); }, [c.almacenId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- búsqueda de productos ----------
  const precioDe = useCallback((u: FilaUnidad) => u.precios?.find((p) => p.lista_id === lista?.id)?.precio ?? null, [lista]);

  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (!buscando) return;
    const h = setTimeout(async () => {
      try {
        const consulta = (extra: string) => {
          let q = supabase().from("productos")
            .select(`id, sku, nombre, unidad_base, permite_fraccion, iva_tasa, ieps_tasa, tipo${extra}, unidades_venta(id, nombre, factor, es_base, orden, precios(precio, lista_id))`)
            .eq("activo", true).order("sku").limit(30);
          if (t) q = q.or(`sku.ilike.%${t}%,nombre.ilike.%${t}%,codigo_barras.eq.${t}`);
          return q;
        };
        let { data, error } = await consulta(", presentacion, m2_por_caja, piezas_por_caja");
        if (error && /presentacion|m2_por_caja|piezas_por_caja/.test(error.message)) ({ data, error } = await consulta("")); // falta la migración 0015
        if (error) throw error;
        setResultados(((data ?? []) as unknown as FilaProducto[]).map(({ unidades_venta, ...p }) => ({
          ...p, unidades: [...unidades_venta].sort((a, b) => a.orden - b.orden).map((u) => ({ ...u, precio: precioDe(u) })),
        })));
        setEnLinea(true);
      } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    }, 200);
    return () => clearTimeout(h);
  }, [texto, buscando, precioDe]);

  const agregar = (p: ProductoVenta) => {
    // Unidad predeterminada: la primera unidad alterna (p. ej. CAJA); si no hay, la base
    const u = p.unidades.find((x) => !x.es_base) ?? p.unidades[0];
    setC((v) => ({ ...v, lineas: [...v.lineas, { uid: crypto.randomUUID(), producto: p, unidadId: u.id, cantidad: "1", precio: u.precio ?? "0", descuento: "0", entregarAhora: true, comentario: "" }] }));
    cargarExistencias([p.id], c.almacenId);
    setTexto(""); setBuscando(false); setResultados([]);
  };

  const editar = (uid: string, cambios: Partial<Linea>) => setC((v) => ({ ...v, lineas: v.lineas.map((l) => (l.uid === uid ? { ...l, ...cambios } : l)) }));

  // ---------- clientes ----------
  useEffect(() => {
    const t = textoCliente.trim().replace(/[%,()]/g, "");
    if (t.length < 2) { setClientes([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabase().from("clientes")
        .select("id, nombre, rfc, es_publico_general, lista_precios_id, limite_credito, dias_credito")
        .eq("activo", true).or(`nombre.ilike.%${t}%,rfc.ilike.%${t}%,razon_social.ilike.%${t}%`).limit(10);
      setClientes((data ?? []) as Cliente[]);
    }, 200);
    return () => clearTimeout(h);
  }, [textoCliente]);

  // ---------- importes ----------
  // Remisión sin IVA (predeterminado): el precio es el importe final y la tasa de IVA queda en 0
  const sinIva = c.sinIva !== false;
  const importes = useMemo(() => c.lineas.map((l) => {
    try { return calcularPartida(l.cantidad || 0, l.precio || 0, l.descuento || 0, sinIva ? "0" : l.producto.iva_tasa, l.producto.ieps_tasa, lista?.incluye ?? true); }
    catch { return null; }
  }), [c.lineas, lista, sinIva]);
  const suma = (k: "subtotal" | "iva" | "total") => importes.reduce((s, i) => s.plus(i?.[k] ?? 0), new Decimal(0));
  const subtotal = suma("subtotal"), iva = suma("iva"), total = suma("total");
  const descuento = c.lineas.reduce((s, l) => s.plus(l.descuento || 0), new Decimal(0));
  // Contado con un solo pago sin importe: se cobra el total completo con esa forma de pago
  const pagoAutomatico = c.tipo === "contado" && c.pagos.length === 1 && !c.pagos[0].importe;
  const pagosAplicados = pagoAutomatico ? [{ ...c.pagos[0], importe: total.toFixed(2) }] : c.pagos;
  const pagado = pagosAplicados.reduce((s, p) => s.plus(p.importe || 0), new Decimal(0));
  const cambio = Decimal.max(pagado.minus(total), 0);
  const faltaPagar = Decimal.max(total.minus(pagado), 0);
  const invalidas = c.lineas.filter((l) => !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion));

  const motivos: string[] = [];
  if (!enLinea) motivos.push("No hay conexión a internet.");
  if (!c.sucursalId || !c.almacenId) motivos.push("Elige sucursal y almacén (si no aparecen, tu usuario no tiene sucursal asignada).");
  if (!c.lineas.length) motivos.push("Agrega al menos un producto.");
  for (const l of invalidas) motivos.push(`${l.producto.nombre}: la cantidad debe ser mayor a 0${l.producto.permite_fraccion ? "" : " y en unidades completas"}.`);
  if (c.lineas.some((l) => Number(l.precio) <= 0)) motivos.push("Hay partidas con precio en 0.");
  if (c.tipo === "credito" && (!c.cliente || c.cliente.es_publico_general)) motivos.push("La venta a crédito requiere un cliente registrado.");
  if (c.tipo === "contado" && c.lineas.length && pagado.lt(total)) motivos.push(`El pago no cubre el total: faltan ${faltaPagar.toFixed(2)}.`);
  const puedeGuardar = !guardando && motivos.length === 0;

  // ---------- guardar ----------
  const guardar = async () => {
    if (!puedeGuardar) return;
    setGuardando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("confirmar_venta", { p: {
        idempotency_key: c.clave, sucursal_id: c.sucursalId, almacen_id: c.almacenId, lista_id: lista?.id,
        cliente_id: c.cliente?.id ?? null, tipo: c.tipo, comentarios: c.comentarios || null, sin_iva: sinIva,
        partidas: c.lineas.map((l) => ({ producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad,
          precio_unitario: l.precio, descuento: l.descuento || 0, entregar_ahora: l.entregarAhora })),
        pagos: pagosAplicados.filter((p) => Number(p.importe) > 0).map((p) => ({ forma: p.forma, importe: p.importe, referencia: p.referencia || null })),
      } });
      if (error) throw error;
      // Captura limpia para la siguiente venta y se abre el documento con sus acciones (imprimir, PDF, enviar…)
      const nueva = capturaNueva(c.sucursalId, c.almacenId, publico);
      try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(nueva)); } catch { /* ignorar */ }
      setC(nueva);
      setExistencias({});
      router.push(`/ventas/${data.venta_id}?nueva=1&cambio=${data.cambio ?? 0}`);
    } catch (e) {
      const m = mensajeError(e);
      if (/conexión/.test(m)) setEnLinea(false);
      setMsg({ tipo: "error", texto: m }); // se conserva la captura y su clave: reintentar no duplica
    } finally { setGuardando(false); }
  };

  // Atajos: F2 agregar producto, F9 guardar
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); setBuscando(true); setTimeout(() => busRef.current?.focus(), 0); }
      if (e.key === "F9") { e.preventDefault(); guardar(); }
      if (e.key === "Escape") { setBuscando(false); setClientes([]); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  return (
    <div className="p-3 sm:p-5">
      {!enLinea && (
        <div role="alert" className="mb-3 rounded px-4 py-3 font-semibold text-white" style={{ background: "var(--peligro)" }}>
          Sin conexión a internet. La venta no se puede guardar ahora; la captura se conserva en este equipo. Reintenta al volver la conexión.
        </div>
      )}
      {msg && (
        <div role="alert" className={`mb-3 rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>
          {msg.texto}
          {msg.avisos?.map((a, i) => <div key={i} className="text-sm">⚠ {a}</div>)}
        </div>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 sm:p-6">
        {/* Encabezado */}
        <div className="flex flex-wrap gap-4 justify-between">
          <div className="text-sm">
            <div className="font-semibold uppercase">{sucursal?.nombre ?? "—"}</div>
            <div className="text-[var(--tenue)]">Remisión · Serie {sucursal ? `${sucursal.codigo}V` : "—"}</div>
            {sucursal?.cp_expedicion && <div className="text-[var(--tenue)]">C.P. {sucursal.cp_expedicion}</div>}
          </div>
          <div className="relative w-full sm:w-80">
            <label className="text-sm">Cliente</label>
            <div className="flex gap-2 items-center">
              <input className="campo" placeholder={c.cliente ? c.cliente.nombre : "Buscar cliente"} value={textoCliente}
                onChange={(e) => setTextoCliente(e.target.value)} />
              {c.cliente && !c.cliente.es_publico_general && (
                <button className="text-xs underline whitespace-nowrap" onClick={() => setC((v) => ({ ...v, cliente: publico, tipo: "contado" }))}>Público en general</button>
              )}
            </div>
            <div className="text-sm mt-1">{c.cliente?.nombre}{c.cliente?.rfc ? ` · ${c.cliente.rfc}` : ""}</div>
            {clientes.length > 0 && (
              <ul className="absolute z-10 w-full bg-[var(--panel)] border border-[var(--borde)] shadow max-h-60 overflow-auto">
                {clientes.map((cl) => (
                  <li key={cl.id} className="px-3 py-2 hover:bg-[var(--resalte)] cursor-pointer text-sm"
                    onClick={() => { setC((v) => ({ ...v, cliente: cl })); setTextoCliente(""); setClientes([]); }}>
                    {cl.nombre}{cl.rfc ? ` · ${cl.rfc}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid gap-3 mt-4 grid-cols-2 lg:grid-cols-4 text-sm">
          <label>Sucursal:
            <select className="campo" value={c.sucursalId} onChange={(e) => {
              const a = almacenes.find((x) => x.sucursal_id === e.target.value)?.id ?? "";
              setC((v) => ({ ...v, sucursalId: e.target.value, almacenId: a }));
            }}>
              {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
            </select>
          </label>
          <label>Almacén:
            <select className="campo" value={c.almacenId} onChange={(e) => setC((v) => ({ ...v, almacenId: e.target.value }))}>
              {almacenesSucursal.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </label>
          <label>Tipo de venta:
            <select className="campo" value={c.tipo} onChange={(e) => setC((v) => ({ ...v, tipo: e.target.value as Captura["tipo"] }))}>
              <option value="contado">Contado</option><option value="credito">Crédito</option>
            </select>
          </label>
          <label>Días de crédito:
            <input className="campo" readOnly value={c.tipo === "credito" ? (c.cliente?.dias_credito ?? 0) : 0} />
          </label>
        </div>

        {/* Partidas */}
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm min-w-[760px]">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left">
                <th className="py-1 font-normal w-24">Código</th><th className="font-normal w-28">Unidad</th><th className="font-normal">Concepto</th>
                <th className="font-normal w-24">Cant.</th><th className="font-normal w-28">Precio</th><th className="font-normal w-28 text-right">Importe</th><th className="w-16"></th>
              </tr>
            </thead>
            <tbody>
              {c.lineas.map((l, i) => {
                const u = l.producto.unidades.find((x) => x.id === l.unidadId) as UnidadVenta;
                const ex = existencias[l.producto.id];
                const exU = ex === undefined ? null : new Decimal(ex).div(u.factor);
                const sinEx = l.producto.tipo === "producto" && ex !== undefined && aBase(l.cantidad || 0, u.factor).gt(ex);
                const invalida = !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion);
                const med = medida(l.producto);
                return (
                  <tr key={l.uid} className="border-t border-[var(--borde)] align-top" style={{ background: i % 2 ? "transparent" : "#f7f9fb" }}>
                    <td className="py-2">{l.producto.sku}</td>
                    <td className="py-1">
                      <select className="campo" value={l.unidadId} onChange={(e) => {
                        const nu = l.producto.unidades.find((x) => x.id === e.target.value)!;
                        editar(l.uid, { unidadId: nu.id, precio: nu.precio ?? "0" });
                      }}>
                        {l.producto.unidades.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                      </select>
                    </td>
                    <td className="py-2">
                      {l.producto.nombre}
                      {l.producto.tipo === "producto" && exU && (
                        <div className={`text-xs ${exU.lt(0) || sinEx ? "text-[var(--peligro)] font-semibold" : "text-[var(--tenue)]"}`}>
                          Exist.: {fmtCantidad(exU, 2)} {u.nombre}
                          {(!u.es_base || med.unidad !== l.producto.unidad_base) && <> ({fmtCantidad(new Decimal(ex!).times(med.porBase), 2)} {med.unidad})</>}
                          {sinEx && " · se venderá sin existencia"}
                        </div>
                      )}
                      {(!u.es_base || med.unidad !== l.producto.unidad_base) && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(aBase(l.cantidad || 0, u.factor).times(med.porBase))} {med.unidad}</div>}
                    </td>
                    <td className="py-1">
                      <input className={`campo ${invalida ? "campo-requerido" : ""}`} inputMode="decimal" value={l.cantidad}
                        onChange={(e) => editar(l.uid, { cantidad: e.target.value })} />
                      {(!u.es_base || med.unidad !== l.producto.unidad_base) && (
                        <button className="text-xs underline" title={`Calcular ${u.nombre} a partir de ${med.unidad}`} onClick={() => {
                          const req = window.prompt(`¿Cuántos ${med.unidad} necesita el cliente?`);
                          if (req && !isNaN(Number(req)) && Number(req) > 0)
                            editar(l.uid, { cantidad: unidadesNecesarias(new Decimal(req).div(med.porBase), u, l.producto.permite_fraccion).unidades.toString() });
                        }}>desde {med.unidad}</button>
                      )}
                      {invalida && <div className="text-xs text-[var(--peligro)]">Solo {u.nombre} completas</div>}
                    </td>
                    <td className="py-1"><input className="campo" inputMode="decimal" value={l.precio} onChange={(e) => editar(l.uid, { precio: e.target.value })} /></td>
                    <td className="py-2 text-right underline decoration-dotted">{importes[i] ? importes[i]!.total.toFixed(2) : "—"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <label title="Se entrega ahora (desmarca si se entrega después)" className="mr-2 text-xs">
                        <input type="checkbox" checked={l.entregarAhora} onChange={(e) => editar(l.uid, { entregarAhora: e.target.checked })} /> Ent.
                      </label>
                      <button aria-label="Quitar partida" className="w-6 h-6 rounded-full text-white text-xs" style={{ background: "var(--peligro)" }}
                        onClick={() => setC((v) => ({ ...v, lineas: v.lineas.filter((x) => x.uid !== l.uid) }))}>✕</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Agregar producto */}
        <div className="relative mt-2">
          {buscando ? (
            <>
              <input ref={busRef} autoFocus className="campo" placeholder="Código, nombre o código de barras…"
                value={texto} onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && resultados[0]) agregar(resultados[0]); }} />
              {resultados.length > 0 && (
                <ul className="absolute z-10 w-full bg-[var(--panel)] border border-[var(--borde)] shadow max-h-72 overflow-auto">
                  {resultados.map((p, i) => (
                    <li key={p.id} onClick={() => agregar(p)}
                      className="px-3 py-2 cursor-pointer text-sm hover:bg-[var(--resalte)]"
                      style={i === 0 ? { background: "var(--acento)", color: "white" } : undefined}>
                      {p.sku} - {p.nombre}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <button onClick={() => setBuscando(true)} className="w-full py-2 text-lg border border-dashed rounded"
              style={{ borderColor: "var(--peligro)", color: "var(--texto)" }}>
              Agregar producto o servicio
            </button>
          )}
        </div>

        {/* Pagos y totales */}
        <div className="barra-seccion mt-6">Pagos</div>
        <div className="grid gap-6 lg:grid-cols-[1fr_280px] mt-3">
          <div className="flex flex-col gap-3 text-sm">
            {c.pagos.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px] sm:grid-cols-[180px_140px_1fr_auto] gap-2 items-center">
                <select className="campo" value={p.forma} onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, forma: e.target.value as Forma } : x)) }))}>
                  {Object.entries(FORMAS).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
                <input className="campo" inputMode="decimal" placeholder={pagoAutomatico && i === 0 ? `${total.toFixed(2)} (total)` : "Importe"} value={p.importe}
                  onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, importe: e.target.value } : x)) }))} />
                <input className="campo col-span-2 sm:col-span-1" placeholder={p.forma === "efectivo" ? "Referencia (opcional)" : "Referencia / últimos 4 dígitos / autorización"} value={p.referencia}
                  onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, referencia: e.target.value } : x)) }))} />
                {c.pagos.length > 1 && (
                  <button className="text-[var(--peligro)]" aria-label="Quitar pago" onClick={() => setC((v) => ({ ...v, pagos: v.pagos.filter((_, j) => j !== i) }))}>✕</button>
                )}
              </div>
            ))}
            <div className="flex gap-4">
              <button className="underline" onClick={() => setC((v) => ({ ...v, pagos: [...v.pagos, { forma: "tarjeta_debito", importe: faltaPagar.gt(0) ? faltaPagar.toFixed(2) : "", referencia: "" }] }))}>+ Agregar forma de pago</button>
              <button className="underline" onClick={() => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === 0 ? { ...x, importe: total.toFixed(2) } : x)) }))}>Pagar el total</button>
            </div>
            <label className="mt-2">Comentarios
              <textarea className="campo h-20" value={c.comentarios} onChange={(e) => setC((v) => ({ ...v, comentarios: e.target.value }))} />
            </label>
          </div>

          <div className="text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1">
              <dt>Subtotal:</dt><dd className="text-right">{subtotal.toFixed(2)}</dd>
              <dt>Descuento:</dt><dd className="text-right">{descuento.toFixed(2)}</dd>
              <dt>
                I.V.A.:
                <label className="ml-2 text-xs whitespace-nowrap" title="Desmarca solo si la venta debe llevar IVA">
                  <input type="checkbox" checked={sinIva} onChange={(e) => setC((v) => ({ ...v, sinIva: e.target.checked }))} /> Sin IVA
                </label>
              </dt><dd className="text-right">{iva.toFixed(2)}</dd>
              <dt className="font-semibold text-base">Total (MXN):</dt><dd className="text-right font-semibold text-base">{total.toFixed(2)}</dd>
              <dt className="mt-2">Pagado:</dt><dd className="text-right mt-2">{pagado.toFixed(2)}</dd>
              {c.tipo === "contado"
                ? <><dt>Cambio:</dt><dd className="text-right font-semibold">{cambio.toFixed(2)}</dd></>
                : <><dt>Saldo a crédito:</dt><dd className="text-right font-semibold">{faltaPagar.toFixed(2)}</dd></>}
            </dl>
            <div className="flex justify-end gap-2 mt-4">
              <button className="px-3 py-2 underline" onClick={() => { if (window.confirm("¿Descartar esta captura?")) setC(capturaNueva(c.sucursalId, c.almacenId, publico)); }}>Descartar</button>
              <button className="btn-primario" title="F9" disabled={!puedeGuardar} onClick={guardar}>{guardando ? "Guardando…" : "Guardar"}</button>
            </div>
            {motivos.length > 0 && !guardando && (
              <ul className="text-xs text-[var(--peligro)] mt-2 text-right">
                {motivos.map((m) => <li key={m}>{m}</li>)}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
