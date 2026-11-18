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
import { EMPRESA_VACIA, EmpresaDoc, cargarEmpresa } from "@/lib/documentoVenta";
import { ProductoVenta, UnidadVenta, aBase, ajustarCantidad, nombreConCaja, calcularPartida, cantidadValida, fmtCantidad, medida, unidadesNecesarias } from "@/lib/unidades";

type Forma = "efectivo" | "transferencia" | "tarjeta_debito" | "tarjeta_credito";
const FORMAS: Record<Forma, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta_debito: "Tarjeta de débito", tarjeta_credito: "Tarjeta de crédito",
};

type TipoDesc = "$" | "%";
interface Linea {
  uid: string; producto: ProductoVenta; unidadId: string; cantidad: string; precio: string; descuento: string; entregarAhora: boolean; comentario: string;
  /** Descuento del renglón en $ o %; verDesc / verComent muestran sus campos */
  descTipo?: TipoDesc; descValor?: string; verDesc?: boolean; verComent?: boolean;
}
interface Pago { forma: Forma; importe: string; referencia: string }
interface Cliente { id: string; nombre: string; rfc: string | null; es_publico_general: boolean; lista_precios_id: string | null; limite_credito: string; dias_credito: number }
interface Almacen { id: string; nombre: string; sucursal_id: string; multisucursal: boolean }
interface Sucursal { id: string; codigo: string; nombre: string; cp_expedicion: string | null; direccion?: string | null; telefono?: string | null }
interface Captura {
  clave: string; sucursalId: string; almacenId: string; cliente: Cliente | null; tipo: "contado" | "credito"; lineas: Linea[]; pagos: Pago[]; comentarios: string; sinIva?: boolean;
  ordenCompra?: string; descGlobalTipo?: TipoDesc; descGlobalValor?: string;
}
interface DetalleProducto { producto: ProductoVenta; filas: { almacen: string; cantidad: number; apartado: number }[] | null }
const CLIENTE_COLS = "id, nombre, rfc, es_publico_general, lista_precios_id, limite_credito, dias_credito";
const RFC_VALIDO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
/** Número o cero (para campos que se están escribiendo) */
const dec = (v: string | undefined) => { try { const d = new Decimal(v || 0); return d.isFinite() ? d : new Decimal(0); } catch { return new Decimal(0); } };

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
  const [existencias, setExistencias] = useState<Record<string, number>>({});   // disponible = existencia − apartado
  const [existTotal, setExistTotal] = useState<Record<string, number>>({});
  const [empresa, setEmpresa] = useState<EmpresaDoc>(EMPRESA_VACIA);
  const [detalle, setDetalle] = useState<DetalleProducto | null>(null);
  const [nuevoCliente, setNuevoCliente] = useState<{ nombre: string; rfc: string; telefono: string } | null>(null);
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
        cargarEmpresa().then(setEmpresa).catch(() => { /* el encabezado es informativo */ });
        let suc = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre, cp_expedicion, direccion, telefono)").eq("user_id", user!.id);
        if (suc.error) suc = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre, cp_expedicion)").eq("user_id", user!.id);
        const [alm, pub, lp] = await Promise.all([
          sb.from("almacenes").select("id, nombre, sucursal_id, multisucursal").eq("activo", true).order("nombre"),
          sb.from("clientes").select(CLIENTE_COLS).eq("es_publico_general", true).maybeSingle(),
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
    const mapa = Object.fromEntries(ids.map((id) => [id, 0])), tot = { ...mapa };
    for (const e of (data ?? []) as { producto_id: string; cantidad: string; apartado: string }[]) {
      mapa[e.producto_id] = Number(e.cantidad) - Number(e.apartado);
      tot[e.producto_id] = Number(e.cantidad);
    }
    setExistencias((prev) => ({ ...prev, ...mapa }));
    setExistTotal((prev) => ({ ...prev, ...tot }));
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

  const verDetalle = async (p: ProductoVenta) => {
    setDetalle({ producto: p, filas: null });
    const { data } = await supabase().from("existencias").select("cantidad, apartado, almacenes(nombre)").eq("producto_id", p.id);
    setDetalle({ producto: p, filas: ((data ?? []) as unknown as { cantidad: string; apartado: string; almacenes: { nombre: string } | null }[])
      .map((e) => ({ almacen: e.almacenes?.nombre ?? "—", cantidad: Number(e.cantidad), apartado: Number(e.apartado) }))
      .sort((a, b) => a.almacen.localeCompare(b.almacen)) });
  };

  const editar = (uid: string, cambios: Partial<Linea>) => setC((v) => ({ ...v, lineas: v.lineas.map((l) => (l.uid === uid ? { ...l, ...cambios } : l)) }));

  // ---------- clientes ----------
  useEffect(() => {
    const t = textoCliente.trim().replace(/[%,()]/g, "");
    if (t.length < 2) { setClientes([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabase().from("clientes")
        .select(CLIENTE_COLS)
        .eq("activo", true).or(`nombre.ilike.%${t}%,rfc.ilike.%${t}%,razon_social.ilike.%${t}%`).limit(10);
      setClientes((data ?? []) as Cliente[]);
    }, 200);
    return () => clearTimeout(h);
  }, [textoCliente]);

  const crearCliente = async () => {
    if (!nuevoCliente) return;
    const nombre = nuevoCliente.nombre.trim(), rfc = nuevoCliente.rfc.trim().toUpperCase();
    if (!nombre) { setMsg({ tipo: "error", texto: "Escribe el nombre del cliente." }); return; }
    if (rfc && !RFC_VALIDO.test(rfc)) { setMsg({ tipo: "error", texto: "El RFC no es válido (12 o 13 caracteres, p. ej. XAXX010101000)." }); return; }
    const { data, error } = await supabase().from("clientes")
      .insert({ nombre, rfc: rfc || null, telefono: nuevoCliente.telefono.trim() || null, sucursal_id: c.sucursalId || null })
      .select(CLIENTE_COLS).single();
    if (error) { setMsg({ tipo: "error", texto: mensajeError(error) }); return; }
    setC((v) => ({ ...v, cliente: data as Cliente }));
    setNuevoCliente(null); setMsg(null);
  };

  // ---------- descuentos ----------
  // Por renglón ($ o % del importe) y general ($ o % de lo que queda), repartido entre los renglones
  // en proporción a su importe: al servidor solo llega el descuento de cada renglón.
  const descuentos = useMemo(() => {
    const brutos = c.lineas.map((l) => dec(l.cantidad).times(dec(l.precio)).toDecimalPlaces(2));
    const propios = c.lineas.map((l, i) => {
      const v = dec(l.descValor);
      return (l.descTipo === "%" ? brutos[i].times(v).div(100) : v).toDecimalPlaces(2);
    });
    const netos = brutos.map((b, i) => Decimal.max(b.minus(propios[i]), 0));
    const sumaNetos = netos.reduce((s, n) => s.plus(n), new Decimal(0));
    const gv = dec(c.descGlobalValor);
    let general = (c.descGlobalTipo === "%" ? sumaNetos.times(gv).div(100) : gv).toDecimalPlaces(2);
    general = Decimal.min(general, sumaNetos);
    const reparto = netos.map(() => new Decimal(0));
    if (general.gt(0) && sumaNetos.gt(0)) {
      let resto = general;
      const ultimo = netos.map((n) => n.gt(0)).lastIndexOf(true);
      netos.forEach((n, i) => {
        if (i === ultimo) { reparto[i] = resto; return; }
        reparto[i] = general.times(n).div(sumaNetos).toDecimalPlaces(2);
        resto = resto.minus(reparto[i]);
      });
    }
    return { porRenglon: propios.map((p, i) => p.plus(reparto[i])), propios, brutos, general };
  }, [c.lineas, c.descGlobalTipo, c.descGlobalValor]);

  // ---------- importes ----------
  // Remisión sin IVA (predeterminado): el precio es el importe final y la tasa de IVA queda en 0
  const sinIva = c.sinIva !== false;
  const importes = useMemo(() => c.lineas.map((l, i) => {
    try { return calcularPartida(l.cantidad || 0, l.precio || 0, descuentos.porRenglon[i] ?? 0, sinIva ? "0" : l.producto.iva_tasa, l.producto.ieps_tasa, lista?.incluye ?? true); }
    catch { return null; }
  }), [c.lineas, lista, sinIva, descuentos]);
  const suma = (k: "subtotal" | "iva" | "total") => importes.reduce((s, i) => s.plus(i?.[k] ?? 0), new Decimal(0));
  const subtotal = suma("subtotal"), iva = suma("iva"), total = suma("total");
  const descuento = descuentos.porRenglon.reduce((s, d) => s.plus(d), new Decimal(0));
  // Contado con un solo pago sin importe: se cobra el total completo con esa forma de pago
  const pagoAutomatico = c.tipo === "contado" && c.pagos.length === 1 && !c.pagos[0].importe;
  const pagosAplicados = pagoAutomatico ? [{ ...c.pagos[0], importe: total.toFixed(2) }] : c.pagos;
  const pagado = pagosAplicados.reduce((s, p) => s.plus(p.importe || 0), new Decimal(0));
  const cambio = Decimal.max(pagado.minus(total), 0);
  const faltaPagar = Decimal.max(total.minus(pagado), 0);
  const invalidas = c.lineas.filter((l) => !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion, l.producto.unidades.find((x) => x.id === l.unidadId)?.factor ?? 1));

  const conDescuento = c.lineas.some((l) => l.verDesc || Number(l.descValor) > 0);
  const motivos: string[] = [];
  if (!enLinea) motivos.push("No hay conexión a internet.");
  if (!c.sucursalId || !c.almacenId) motivos.push("Elige sucursal y almacén (si no aparecen, tu usuario no tiene sucursal asignada).");
  if (!c.lineas.length) motivos.push("Agrega al menos un producto.");
  for (const l of invalidas) motivos.push(`${l.producto.nombre}: la cantidad debe ser mayor a 0${l.producto.permite_fraccion ? "" : " y en unidades completas"}.`);
  if (c.lineas.some((l) => Number(l.precio) <= 0)) motivos.push("Hay partidas con precio en 0.");
  c.lineas.forEach((l, i) => { if (descuentos.propios[i].gt(descuentos.brutos[i])) motivos.push(`${l.producto.nombre}: el descuento es mayor al importe.`); });
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
        orden_compra: c.ordenCompra?.trim() || null,
        partidas: c.lineas.map((l, i) => ({ producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad,
          precio_unitario: l.precio, descuento: descuentos.porRenglon[i].toFixed(2), entregar_ahora: l.entregarAhora,
          comentario: l.comentario?.trim() || null })),
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
        <div className="flex flex-wrap md:flex-nowrap gap-4 justify-between">
          <div className="flex gap-4 items-start text-sm flex-1 min-w-0">
            {empresa.logos.length > 0 && (
              <div className="flex flex-wrap gap-1 max-w-40">
                {empresa.logos.slice(0, 4).map((src, i) => <img key={i} src={src} alt="" className="max-h-10 max-w-[76px] object-contain" />)}
              </div>
            )}
            <div>
              <div className="uppercase">{empresa.nombre_emisor || empresa.razon_social || sucursal?.nombre || "—"}</div>
              {(empresa.rfc || sucursal?.telefono || empresa.telefono) && (
                <div>{empresa.rfc && <>RFC: {empresa.rfc} </>}{(sucursal?.telefono || empresa.telefono) && <>Teléfono: {sucursal?.telefono || empresa.telefono}</>}</div>
              )}
              {sucursal?.direccion && <div className="max-w-xl">{sucursal.direccion}{sucursal.cp_expedicion && !/C\.?\s*P\.?\s*\d/i.test(sucursal.direccion) ? ` C.P. ${sucursal.cp_expedicion}` : ""}</div>}
              <div className="text-[var(--tenue)]">Remisión · Serie {sucursal ? `${sucursal.codigo}V` : "—"}</div>
            </div>
          </div>
          <div className="relative w-full md:w-80 shrink-0">
            <div className="flex gap-2 items-center">
              <input className="campo text-center" style={{ borderColor: "var(--peligro)", borderStyle: "dashed" }} placeholder="Buscar cliente" value={textoCliente}
                onChange={(e) => setTextoCliente(e.target.value)} />
              {c.cliente && !c.cliente.es_publico_general && (
                <button className="text-xs underline whitespace-nowrap" onClick={() => setC((v) => ({ ...v, cliente: publico, tipo: "contado" }))}>Público en general</button>
              )}
              <button className="text-xs underline whitespace-nowrap" onClick={() => setNuevoCliente(nuevoCliente ? null : { nombre: textoCliente, rfc: "", telefono: "" })}>+ Nuevo</button>
            </div>
            {nuevoCliente && (
              <div className="mt-2 p-2 border border-[var(--borde)] rounded flex flex-col gap-2 text-sm">
                <input className="campo" placeholder="Nombre *" autoFocus value={nuevoCliente.nombre} onChange={(e) => setNuevoCliente({ ...nuevoCliente, nombre: e.target.value })} />
                <div className="grid grid-cols-2 gap-2">
                  <input className="campo" placeholder="RFC (opcional)" value={nuevoCliente.rfc} onChange={(e) => setNuevoCliente({ ...nuevoCliente, rfc: e.target.value.toUpperCase() })} />
                  <input className="campo" placeholder="Teléfono" inputMode="tel" value={nuevoCliente.telefono} onChange={(e) => setNuevoCliente({ ...nuevoCliente, telefono: e.target.value })} />
                </div>
                <div className="flex justify-end gap-3">
                  <button className="underline" onClick={() => setNuevoCliente(null)}>Cancelar</button>
                  <button className="btn-primario" onClick={crearCliente}>Dar de alta</button>
                </div>
              </div>
            )}
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

        <div className="grid gap-3 mt-4 grid-cols-2 lg:grid-cols-5 text-sm">
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
          <label>Orden de compra:
            <input className="campo" value={c.ordenCompra ?? ""} onChange={(e) => setC((v) => ({ ...v, ordenCompra: e.target.value }))} />
          </label>
        </div>

        {/* Partidas */}
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm min-w-[760px]">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left">
                <th className="py-1 font-normal w-24">Código</th><th className="font-normal w-28">Unidad</th><th className="font-normal">Concepto</th>
                <th className="font-normal w-24">Cant.</th><th className="font-normal w-28">Precio</th>
                {conDescuento && <th className="font-normal w-36">Descuento</th>}
                <th className="font-normal w-28 text-right">Importe</th><th className="w-28"></th>
              </tr>
            </thead>
            <tbody>
              {c.lineas.map((l, i) => {
                const u = l.producto.unidades.find((x) => x.id === l.unidadId) as UnidadVenta;
                const ex = existencias[l.producto.id];
                const exU = ex === undefined ? null : new Decimal(ex).div(u.factor);
                const tot = existTotal[l.producto.id];
                const totU = tot === undefined ? null : new Decimal(tot).div(u.factor);
                const sinEx = l.producto.tipo === "producto" && ex !== undefined && aBase(l.cantidad || 0, u.factor).gt(ex);
                const invalida = !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion, u.factor);
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
                      {nombreConCaja(l.producto.nombre, l.producto.m2_por_caja)}
                      <button className="ml-2 text-xs px-1 border rounded border-[var(--acento)] text-[var(--acento)]" title="Ver detalle y existencia por almacén"
                        aria-label="Ver detalle del producto" onClick={() => verDetalle(l.producto)}>👁</button>
                      {l.producto.tipo === "producto" && exU && (
                        <div className={`text-xs ${exU.lt(0) || sinEx ? "text-[var(--peligro)] font-semibold" : "text-[var(--tenue)]"}`}>
                          {totU && <>Exist.: {fmtCantidad(totU, 2)} {u.nombre}{(!u.es_base || med.unidad !== l.producto.unidad_base) && <> ({fmtCantidad(new Decimal(tot!).times(med.porBase), 2)} {med.unidad})</>} · </>}
                          Disp.: {fmtCantidad(exU, 2)} {u.nombre}
                          {(!u.es_base || med.unidad !== l.producto.unidad_base) && <> ({fmtCantidad(new Decimal(ex!).times(med.porBase), 2)} {med.unidad})</>}
                          {sinEx && " · se venderá sin existencia"}
                        </div>
                      )}
                      {(l.verComent || l.comentario) && (
                        <textarea className="campo h-12 mt-1 text-xs" placeholder="Comentario del renglón (sale en la nota)" value={l.comentario}
                          onChange={(e) => editar(l.uid, { comentario: e.target.value })} />
                      )}
                      {u.nombre === med.unidad
                        ? <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(aBase(l.cantidad || 0, u.factor), 2)} {l.producto.unidad_base}</div>
                        : (!u.es_base || med.unidad !== l.producto.unidad_base) && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(aBase(l.cantidad || 0, u.factor).times(med.porBase))} {med.unidad}</div>}
                    </td>
                    <td className="py-1">
                      <input className={`campo ${invalida ? "campo-requerido" : ""}`} inputMode="decimal" value={l.cantidad}
                        onChange={(e) => editar(l.uid, { cantidad: e.target.value })}
                        onBlur={() => { const a = ajustarCantidad(l.cantidad, u, l.producto); if (a !== l.cantidad) editar(l.uid, { cantidad: a }); }} />
                      {(!u.es_base || med.unidad !== l.producto.unidad_base) && u.nombre !== med.unidad && (
                        <button className="text-xs underline" title={`Calcular ${u.nombre} a partir de ${med.unidad}`} onClick={() => {
                          const req = window.prompt(`¿Cuántos ${med.unidad} necesita el cliente?`);
                          if (req && !isNaN(Number(req)) && Number(req) > 0)
                            editar(l.uid, { cantidad: unidadesNecesarias(new Decimal(req).div(med.porBase), u, l.producto.permite_fraccion).unidades.toString() });
                        }}>desde {med.unidad}</button>
                      )}
                      {invalida && <div className="text-xs text-[var(--peligro)]">{u.nombre === "M2" ? "Debe equivaler a piezas completas" : `Solo ${u.nombre} completas`}</div>}
                    </td>
                    <td className="py-1"><input className="campo" inputMode="decimal" value={l.precio} onChange={(e) => editar(l.uid, { precio: e.target.value })} /></td>
                    {conDescuento && (
                      <td className="py-1">
                        {(l.verDesc || Number(l.descValor) > 0) && (
                          <div className="flex gap-1">
                            <select className="campo !w-14 !px-1" value={l.descTipo ?? "$"} onChange={(e) => editar(l.uid, { descTipo: e.target.value as TipoDesc })}>
                              <option value="$">$</option><option value="%">%</option>
                            </select>
                            <input className="campo" inputMode="decimal" placeholder="0" value={l.descValor ?? ""} onChange={(e) => editar(l.uid, { descValor: e.target.value })} />
                          </div>
                        )}
                      </td>
                    )}
                    <td className="py-2 text-right underline decoration-dotted">{importes[i] ? importes[i]!.total.toFixed(2) : "—"}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button className="mr-1 w-6 h-6 rounded-full text-white text-xs" style={{ background: l.verDesc || Number(l.descValor) > 0 ? "var(--acento)" : "#777" }}
                        title="Descuento del renglón" aria-label="Descuento del renglón" onClick={() => editar(l.uid, { verDesc: !l.verDesc })}>%</button>
                      <button className="mr-2 w-6 h-6 rounded-full text-white text-xs" style={{ background: l.verComent || l.comentario ? "var(--acento)" : "#777" }}
                        title="Comentario del renglón" aria-label="Comentario del renglón" onClick={() => editar(l.uid, { verComent: !l.verComent })}>💬</button>
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
                      {p.sku} - {nombreConCaja(p.nombre, p.m2_por_caja)}
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
              <dt>Subtotal:</dt><dd className="text-right">{subtotal.plus(descuento).toFixed(2)}</dd>
              <dt className="flex items-center gap-1">Descuento
                <select className="campo !w-14 !px-1 !py-0.5" value={c.descGlobalTipo ?? "$"} onChange={(e) => setC((v) => ({ ...v, descGlobalTipo: e.target.value as TipoDesc }))}>
                  <option value="$">$</option><option value="%">%</option>
                </select>
                <input className="campo !w-20 !py-0.5 text-right" inputMode="decimal" placeholder="0" value={c.descGlobalValor ?? ""}
                  onChange={(e) => setC((v) => ({ ...v, descGlobalValor: e.target.value }))} />
              </dt><dd className="text-right self-center">{descuento.toFixed(2)}</dd>
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

      {detalle && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setDetalle(null)}>
          <div role="dialog" aria-label="Detalle del producto" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-xl p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-3">
              <h2 className="text-lg font-semibold">{detalle.producto.sku} · {nombreConCaja(detalle.producto.nombre, detalle.producto.m2_por_caja)}</h2>
              <button aria-label="Cerrar" className="text-[var(--peligro)] text-lg" onClick={() => setDetalle(null)}>✕</button>
            </div>
            <div className="text-[var(--tenue)] mt-1">
              Inventario en {detalle.producto.unidad_base}
              {detalle.producto.piezas_por_caja && detalle.producto.m2_por_caja && <> · Caja: {detalle.producto.piezas_por_caja} piezas = {fmtCantidad(detalle.producto.m2_por_caja, 4)} m²</>}
            </div>
            <table className="w-full mt-3">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left"><th className="font-normal py-1">Almacén</th><th className="font-normal text-right">Existencia</th><th className="font-normal text-right">Apartado</th><th className="font-normal text-right">Disponible</th></tr></thead>
              <tbody>
                {detalle.filas === null && <tr><td colSpan={4} className="py-3 text-center text-[var(--tenue)]">Cargando…</td></tr>}
                {detalle.filas?.length === 0 && <tr><td colSpan={4} className="py-3 text-center text-[var(--tenue)]">Sin existencia registrada en ningún almacén.</td></tr>}
                {detalle.filas?.map((f) => {
                  const caja = detalle.producto.piezas_por_caja;
                  const fmt = (n: number) => caja ? `${fmtCantidad(Math.trunc(n / caja), 0)} cj${n % caja ? ` + ${fmtCantidad(n % caja, 2)} pz` : ""}` : fmtCantidad(n, 2);
                  return (
                    <tr key={f.almacen} className="border-t border-[var(--borde)]">
                      <td className="py-1">{f.almacen}</td><td className="text-right">{fmt(f.cantidad)}</td>
                      <td className="text-right">{fmt(f.apartado)}</td><td className={`text-right ${f.cantidad - f.apartado < 0 ? "text-[var(--peligro)]" : ""}`}>{fmt(f.cantidad - f.apartado)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-end mt-4"><button className="btn-primario" onClick={() => setDetalle(null)}>Aceptar</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
