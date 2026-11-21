"use client";
/**
 * Ventas › Capturar venta
 * Distribución familiar para el personal: encabezado (empresa, cliente, sucursal, almacén),
 * partidas (Código · Unidad · Concepto con existencia · Cant. · Precio · Importe),
 * sección Pagos, comentarios y totales a la derecha. Guarda con confirmar_venta (una transacción).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Decimal from "decimal.js";
import { useRouter } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { EMPRESA_VACIA, EmpresaDoc, cargarEmpresa } from "@/lib/documentoVenta";
import { TIPO_VENTA, ProductoVenta, UnidadVenta, aBase, ajustarCantidad, nombreConCaja, calcularPartida, cantidadValida, fmtCantidad, fmtImporte, medida, unidadesNecesarias } from "@/lib/unidades";

type Forma = "efectivo" | "transferencia" | "tarjeta_debito" | "tarjeta_credito" | "saldo_favor";
const FORMAS: Record<Forma, string> = {
  efectivo: "Efectivo", transferencia: "Transferencia", tarjeta_debito: "Tarjeta de débito", tarjeta_credito: "Tarjeta de crédito", saldo_favor: "Saldo a favor",
};

type TipoDesc = "$" | "%";
interface Linea {
  uid: string; producto: ProductoVenta; unidadId: string; cantidad: string; precio: string; descuento: string; entregarAhora: boolean; comentario: string;
  /** Descuento del renglón en $ o %; verDesc / verComent muestran sus campos */
  descTipo?: TipoDesc; descValor?: string; verDesc?: boolean; verComent?: boolean;
  /** Edición: renglón existente y lo ya entregado (en la unidad vendida) */
  partidaId?: string; entregada?: string;
  /** Almacén (bodega) de donde sale este renglón; vacío = el de la venta */
  almacenId?: string;
  /** Nombre escrito en el renglón (conceptos con nombre libre, p. ej. CVG) */
  descripcion?: string;
}
interface Pago { forma: Forma; importe: string; referencia: string }
interface Cliente { id: string; nombre: string; rfc: string | null; es_publico_general: boolean; lista_precios_id: string | null; limite_credito: string; dias_credito: number; bloqueado?: boolean }
interface Almacen { id: string; nombre: string; sucursal_id: string; multisucursal: boolean }
interface Sucursal { id: string; codigo: string; nombre: string; cp_expedicion: string | null; direccion?: string | null; telefono?: string | null; almacen_predeterminado_id?: string | null }
interface Captura {
  clave: string; sucursalId: string; almacenId: string; cliente: Cliente | null; tipo: "contado" | "credito" | "abono"; lineas: Linea[]; pagos: Pago[]; comentarios: string; sinIva?: boolean;
  ordenCompra?: string; descGlobalTipo?: TipoDesc; descGlobalValor?: string;
  /** El cambio se queda como saldo a favor del cliente (0038) */
  cambioAFavor?: boolean;
  /** Edición de una venta ya guardada (mismo folio) */
  edicion?: { ventaId: string; folio: string; pagado: string };
  /** Modo cotización: se guarda como cotización (sin pagos); id/folio si se está editando una */
  cotizacion?: { id?: string; folio?: string; vigencia: string; prospecto?: string };
  /** Venta que sale de una cotización (respeta sus precios y la marca como convertida) */
  desdeCotizacion?: { id: string; folio: string };
}
interface DetalleProducto { producto: ProductoVenta; filas: { almacen: string; cantidad: number; apartado: number }[] | null }
const CLIENTE_COLS = "id, nombre, rfc, es_publico_general, lista_precios_id, limite_credito, dias_credito, bloqueado";
const RFC_VALIDO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
/** Número o cero (para campos que se están escribiendo) */
const dec = (v: string | undefined) => { try { const d = new Decimal(v || 0); return d.isFinite() ? d : new Decimal(0); } catch { return new Decimal(0); } };

interface FilaUnidad { id: string; nombre: string; factor: string; es_base: boolean; orden: number; precios?: { precio: string; lista_id: string }[] }
interface FilaProducto extends Omit<ProductoVenta, "unidades"> { unidades_venta: FilaUnidad[] }

/**
 * Conceptos (0044): nombre escrito por renglón y opciones nombre/precio libre del producto.
 * Consulta aparte para que la captura funcione aunque falte la migración.
 */
async function conceptosDe(tabla: "venta_partidas" | "cotizacion_partidas", col: "venta_id" | "cotizacion_id", id: string, lineas: Linea[], renglones: number[]) {
  const { data, error } = await supabase().from(tabla).select("renglon, descripcion, productos(nombre_libre, precio_libre)").eq(col, id);
  if (error || !data) return lineas;
  const filas = data as unknown as { renglon: number; descripcion: string | null; productos: { nombre_libre: boolean; precio_libre: boolean } | null }[];
  return lineas.map((l, i) => {
    const f = filas.find((x) => x.renglon === renglones[i]);
    return f ? { ...l, descripcion: f.descripcion ?? "", producto: { ...l.producto, nombre_libre: !!f.productos?.nombre_libre, precio_libre: !!f.productos?.precio_libre } } : l;
  });
}

const CLAVE_LOCAL = "captura-venta-v1";
/** Fecha (AAAA-MM-DD, hora de México) dentro de n días */
const masDias = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }); };
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
  const [saldoFavor, setSaldoFavor] = useState(0);
  const [deuda, setDeuda] = useState<{ debe: number; vencido: number } | null>(null);   // del cliente, para la venta a crédito
  const [puedeAutorizar, setPuedeAutorizar] = useState(false);
  const [cambiarCliente, setCambiarCliente] = useState(false);
  const [diferencia, setDiferencia] = useState<{ exceso: Decimal; opcion: "devolver" | "saldo_favor"; forma: Forma } | null>(null);
  const busRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // ---------- carga inicial ----------
  useEffect(() => {
    (async () => {
      try {
        const sb = supabase();
        const { data: { user } } = await sb.auth.getUser();
        cargarEmpresa().then(setEmpresa).catch(() => { /* el encabezado es informativo */ });
        let suc = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre, cp_expedicion, direccion, telefono, almacen_predeterminado_id)").eq("user_id", user!.id);
        if (suc.error) suc = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre, cp_expedicion, direccion, telefono)").eq("user_id", user!.id);
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

        const qs = new URLSearchParams(window.location.search);
        const editarId = qs.get("editar");
        if (editarId) { await cargarEdicion(editarId, lp.data?.id ?? null); return; }
        // Cotizaciones: nueva (?cotizar=1), editar (?cotizacion=id) o vender desde una (?desde_cotizacion=id)
        const s0c = sucs[0]?.id ?? "", a0c = sucs[0]?.almacen_predeterminado_id ?? ((alm.data ?? []) as Almacen[]).find((a) => a.sucursal_id === s0c)?.id ?? "";
        if (qs.get("cotizar")) { setC({ ...capturaNueva(s0c, a0c, pub.data as Cliente), cotizacion: { vigencia: masDias(15) } }); return; }
        const cotId = qs.get("cotizacion") || qs.get("desde_cotizacion") || qs.get("copiar_cotizacion");
        const modoCot = qs.get("desde_cotizacion") ? "vender" : qs.get("copiar_cotizacion") ? "copiar" : "editar";
        if (cotId) { await cargarCotizacionCaptura(cotId, lp.data?.id ?? null, modoCot, pub.data as Cliente); return; }
        let guardada: Captura | null = null;
        try { const s = localStorage.getItem(CLAVE_LOCAL); if (s) guardada = JSON.parse(s); } catch { /* sin almacenamiento */ }
        if (guardada?.edicion || guardada?.cotizacion || guardada?.desdeCotizacion) guardada = null;
        if (guardada && guardada.lineas.length) setC(guardada);
        else {
          const s0 = sucs[0]?.id ?? "";
          const a0 = sucs[0]?.almacen_predeterminado_id ?? ((alm.data ?? []) as Almacen[]).find((a) => a.sucursal_id === s0)?.id ?? "";
          setC(capturaNueva(s0, a0, pub.data as Cliente));
        }
      } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    })();
  }, []);

  // La captura se conserva en este equipo hasta guardarla (por si se va la conexión); la edición no
  useEffect(() => { if (c.edicion || c.cotizacion || c.desdeCotizacion) return; try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(c)); } catch { /* ignorar */ } }, [c]);

  /** Carga una cotización para editarla, o para venderla (desde=true) con sus precios. */
  async function cargarCotizacionCaptura(id: string, listaId: string | null, modo: "editar" | "vender" | "copiar", publicoGeneral: Cliente) {
    const { data, error } = await supabase().from("cotizaciones").select(`id, serie, folio, sucursal_id, almacen_id, vigencia, estado, comentarios, sin_iva, prospecto,
      clientes(${CLIENTE_COLS}),
      cotizacion_partidas(renglon, unidad_venta_id, cantidad, precio_unitario, descuento, comentario,
        productos(id, sku, nombre, unidad_base, permite_fraccion, iva_tasa, ieps_tasa, tipo, imagen_url, presentacion, m2_por_caja, piezas_por_caja, formato,
          unidades_venta(id, nombre, factor, es_base, orden, precios(precio, lista_id))))`).eq("id", id).maybeSingle();
    if (error) {
      if (/sin_iva|comentario/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000037_cotizaciones.sql en Supabase.");
      throw error;
    }
    if (!data) throw new Error("No se encontró la cotización o no tienes acceso a su sucursal.");
    const q = data as unknown as { id: string; serie: string; folio: number; sucursal_id: string; almacen_id: string; vigencia: string; estado: string;
      comentarios: string | null; sin_iva: boolean; prospecto: string | null; clientes: Cliente | null;
      cotizacion_partidas: { renglon: number; unidad_venta_id: string; cantidad: string; precio_unitario: string; descuento: string; comentario: string | null; productos: FilaProducto }[] };
    if (modo !== "copiar" && q.estado === "convertida") throw new Error("Esta cotización ya se convirtió en venta.");
    if (modo !== "copiar" && q.estado === "cancelada") throw new Error("Esta cotización está cancelada.");
    const ordenadasQ = [...q.cotizacion_partidas].sort((a, b) => a.renglon - b.renglon);
    let lineas: Linea[] = ordenadasQ.map((cp) => {
      const { unidades_venta, ...prod } = cp.productos;
      const producto: ProductoVenta = { ...prod, unidades: [...unidades_venta].sort((a, b) => a.orden - b.orden)
        .map((u) => ({ ...u, precio: u.precios?.find((x) => x.lista_id === listaId)?.precio ?? null })) };
      return { uid: crypto.randomUUID(), producto, unidadId: cp.unidad_venta_id, cantidad: String(Number(cp.cantidad)), precio: String(Number(cp.precio_unitario)),
        descuento: "0", entregarAhora: true, comentario: cp.comentario ?? "",
        descTipo: "$", descValor: Number(cp.descuento) > 0 ? String(Number(cp.descuento)) : "", verDesc: Number(cp.descuento) > 0 };
    });
    lineas = await conceptosDe("cotizacion_partidas", "cotizacion_id", q.id, lineas, ordenadasQ.map((x) => x.renglon));
    const folio = `${q.serie} ${q.folio}`;
    setC({ ...capturaNueva(q.sucursal_id, q.almacen_id, q.clientes ?? publicoGeneral), lineas, comentarios: q.comentarios ?? "", sinIva: q.sin_iva !== false,
      ...(modo === "vender" ? { desdeCotizacion: { id: q.id, folio } }
        : modo === "copiar" ? { cotizacion: { vigencia: masDias(15), prospecto: q.prospecto ?? "" } }
        : { cotizacion: { id: q.id, folio, vigencia: q.vigencia, prospecto: q.prospecto ?? "" } }) });
    cargarExistencias([...new Set(lineas.map((l) => l.producto.id))], q.almacen_id);
  }

  /** Carga una venta guardada para editarla en esta misma pantalla. */
  async function cargarEdicion(id: string, listaId: string | null) {
    const sb = supabase();
    const { data, error } = await sb.from("ventas").select(`id, serie, folio, sucursal_id, almacen_id, tipo, con_abono, pagado, comentarios, orden_compra, sin_iva, cerrada, estado,
      clientes(${CLIENTE_COLS}),
      venta_partidas(id, renglon, unidad_venta_id, cantidad, cantidad_entregada, precio_unitario, descuento, comentario, almacen_id,
        productos(id, sku, nombre, unidad_base, permite_fraccion, iva_tasa, ieps_tasa, tipo, imagen_url, presentacion, m2_por_caja, piezas_por_caja, formato,
          unidades_venta(id, nombre, factor, es_base, orden, precios(precio, lista_id))))`).eq("id", id).maybeSingle();
    if (error) {
      if (/cerrada|con_abono|orden_compra/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000027_ventas_editables.sql en Supabase.");
      if (/almacen_id/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000028_folio_y_almacen_por_renglon.sql en Supabase.");
      throw error;
    }
    if (!data) throw new Error("No se encontró la venta o no tienes acceso a su sucursal.");
    const v = data as unknown as {
      id: string; serie: string; folio: number; sucursal_id: string; almacen_id: string; tipo: "contado" | "credito"; con_abono: boolean; pagado: string;
      comentarios: string | null; orden_compra: string | null; sin_iva: boolean; cerrada: boolean; estado: string; clientes: Cliente;
      venta_partidas: { id: string; renglon: number; unidad_venta_id: string; cantidad: string; cantidad_entregada: string; precio_unitario: string; descuento: string; comentario: string | null; almacen_id: string | null;
        productos: FilaProducto }[];
    };
    if (v.estado !== "confirmada") throw new Error("La venta está cancelada; ya no se puede editar.");
    if (v.cerrada) throw new Error("La venta está cerrada; ya no se puede editar.");
    const ordenadasV = [...v.venta_partidas].sort((a, b) => a.renglon - b.renglon);
    let lineas: Linea[] = ordenadasV.map((vp) => {
      const { unidades_venta, ...prod } = vp.productos;
      const producto: ProductoVenta = { ...prod, unidades: [...unidades_venta].sort((a, b) => a.orden - b.orden)
        .map((u) => ({ ...u, precio: u.precios?.find((x) => x.lista_id === listaId)?.precio ?? null })) };
      return { uid: crypto.randomUUID(), producto, unidadId: vp.unidad_venta_id, cantidad: String(Number(vp.cantidad)), precio: String(Number(vp.precio_unitario)),
        descuento: "0", entregarAhora: Number(vp.cantidad_entregada) >= Number(vp.cantidad), comentario: vp.comentario ?? "",
        descTipo: "$", descValor: Number(vp.descuento) > 0 ? String(Number(vp.descuento)) : "", verDesc: Number(vp.descuento) > 0,
        partidaId: vp.id, entregada: String(Number(vp.cantidad_entregada)), almacenId: vp.almacen_id && vp.almacen_id !== v.almacen_id ? vp.almacen_id : undefined };
    });
    lineas = await conceptosDe("venta_partidas", "venta_id", v.id, lineas, ordenadasV.map((x) => x.renglon));
    setC({ clave: crypto.randomUUID(), sucursalId: v.sucursal_id, almacenId: v.almacen_id, cliente: v.clientes,
      tipo: v.tipo === "credito" ? "credito" : v.con_abono ? "abono" : "contado", lineas, pagos: [], comentarios: v.comentarios ?? "",
      sinIva: v.sin_iva !== false, ordenCompra: v.orden_compra ?? "", edicion: { ventaId: v.id, folio: `${v.serie} ${v.folio}`, pagado: String(v.pagado) } });
    const porAlm = new Map<string, Set<string>>();
    for (const l of lineas) { const a = l.almacenId || v.almacen_id; if (!porAlm.has(a)) porAlm.set(a, new Set()); porAlm.get(a)!.add(l.producto.id); }
    porAlm.forEach((ids, a) => cargarExistencias([...ids], a));
  }

  useEffect(() => {
    const on = () => setEnLinea(true), off = () => setEnLinea(false);
    setEnLinea(navigator.onLine);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  const almacenesSucursal = almacenes.filter((a) => a.sucursal_id === c.sucursalId || a.multisucursal);
  const sucursal = sucursales.find((s) => s.id === c.sucursalId);

  // ---------- existencias por producto y almacén (clave "producto|almacén") ----------
  const almDe = (l: Linea) => l.almacenId || c.almacenId;
  const claveEx = (productoId: string, almacenId: string) => `${productoId}|${almacenId}`;
  const cargarExistencias = useCallback(async (ids: string[], almacenId: string) => {
    if (!ids.length || !almacenId) return;
    const { data } = await supabase().from("existencias").select("producto_id, cantidad, apartado").eq("almacen_id", almacenId).in("producto_id", ids);
    const mapa: Record<string, number> = Object.fromEntries(ids.map((id) => [`${id}|${almacenId}`, 0])), tot = { ...mapa };
    for (const e of (data ?? []) as { producto_id: string; cantidad: string; apartado: string }[]) {
      mapa[`${e.producto_id}|${almacenId}`] = Number(e.cantidad) - Number(e.apartado);
      tot[`${e.producto_id}|${almacenId}`] = Number(e.cantidad);
    }
    setExistencias((prev) => ({ ...prev, ...mapa }));
    setExistTotal((prev) => ({ ...prev, ...tot }));
  }, []);

  useEffect(() => {
    const porAlm = new Map<string, Set<string>>();
    for (const l of c.lineas) { const a = l.almacenId || c.almacenId; if (!porAlm.has(a)) porAlm.set(a, new Set()); porAlm.get(a)!.add(l.producto.id); }
    porAlm.forEach((ids, a) => cargarExistencias([...ids], a));
  }, [c.almacenId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- búsqueda de productos ----------
  const precioDe = useCallback((u: FilaUnidad) => u.precios?.find((p) => p.lista_id === lista?.id)?.precio ?? null, [lista]);

  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (!buscando) return;
    const h = setTimeout(async () => {
      try {
        const consulta = (extra: string) => {
          let q = supabase().from("productos")
            .select(`id, sku, nombre, unidad_base, permite_fraccion, iva_tasa, ieps_tasa, tipo, imagen_url${extra}, unidades_venta(id, nombre, factor, es_base, orden, precios(precio, lista_id))`)
            .eq("activo", true).order("sku").limit(30);
          if (t) q = q.or(`sku.ilike.%${t}%,nombre.ilike.%${t}%,codigo_barras.eq.${t}`);
          return q;
        };
        let { data, error } = await consulta(", presentacion, m2_por_caja, piezas_por_caja, formato, nombre_libre, precio_libre");
        if (error && /nombre_libre|precio_libre/.test(error.message)) ({ data, error } = await consulta(", presentacion, m2_por_caja, piezas_por_caja, formato")); // falta 0044
        if (error && /presentacion|m2_por_caja|piezas_por_caja|formato/.test(error.message)) ({ data, error } = await consulta("")); // falta la migración 0015
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
    setC((v) => ({ ...v, lineas: [...v.lineas, { uid: crypto.randomUUID(), producto: p, unidadId: u.id, cantidad: "1",
      precio: u.precio ?? (p.precio_libre ? "" : "0"), descuento: "0", entregarAhora: true, comentario: "", descripcion: "" }] }));
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
    setNuevoCliente(null); setMsg(null); setCambiarCliente(false);
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

  // Saldo a favor del cliente elegido (0027); si falta la migración queda en 0
  useEffect(() => {
    setSaldoFavor(0);
    if (!c.cliente || c.cliente.es_publico_general) return;
    supabase().from("clientes").select("saldo_a_favor").eq("id", c.cliente.id).maybeSingle()
      .then(({ data }: { data: unknown }) => setSaldoFavor(Number((data as { saldo_a_favor?: string } | null)?.saldo_a_favor ?? 0)));
  }, [c.cliente]);

  // Lo que debe el cliente (para avisar en la venta a crédito antes de guardar)
  useEffect(() => {
    setDeuda(null);
    if (c.tipo !== "credito" || !c.cliente || c.cliente.es_publico_general) return;
    const hoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
    const sb = supabase();
    sb.from("ventas").select("id, saldo, vencimiento").eq("cliente_id", c.cliente.id).eq("estado", "confirmada").gt("saldo", 0)
      .then(({ data }: { data: unknown }) => {
        const f = ((data ?? []) as { id: string; saldo: string; vencimiento: string | null }[]).filter((x) => x.id !== c.edicion?.ventaId);
        setDeuda({ debe: f.reduce((a, x) => a + Number(x.saldo), 0),
          vencido: f.filter((x) => x.vencimiento && x.vencimiento < hoy).reduce((a, x) => a + Number(x.saldo), 0) });
      });
    sb.rpc("tiene_permiso", { p_permiso: "otorgar_credito" }).then(({ data }: { data: unknown }) => setPuedeAutorizar(data === true));
  }, [c.tipo, c.cliente, c.edicion?.ventaId]);

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
  c.lineas.forEach((l) => { if (l.entregada && dec(l.cantidad).lt(dec(l.entregada))) motivos.push(`${l.producto.nombre}: no puedes dejar menos de lo ya entregado (${fmtCantidad(l.entregada)}).`); });
  if (c.cotizacion && !c.cotizacion.vigencia) motivos.push("Indica la vigencia de la cotización.");
  if (!c.edicion && !c.cotizacion) {
    for (const l of c.lineas) if (l.producto.nombre_libre && !l.descripcion?.trim()) motivos.push(`${l.producto.sku}: escribe el nombre del concepto.`);
    for (const l of c.lineas) if (l.producto.precio_libre && !(Number(l.precio) >= 0 && l.precio !== "")) motivos.push(`${l.producto.sku}: escribe el precio.`);
    if (c.tipo === "credito" && (!c.cliente || c.cliente.es_publico_general)) motivos.push("La venta a crédito requiere un cliente registrado.");
    if (c.tipo === "abono" && (!c.cliente || c.cliente.es_publico_general)) motivos.push("Para dejar saldo pendiente elige o da de alta al cliente (+ Nuevo).");
    if (c.tipo === "abono" && pagado.gt(total)) motivos.push("El abono es mayor al total de la venta.");
    if (c.tipo === "contado" && c.lineas.length && pagado.lt(total)) motivos.push(`El pago no cubre el total: faltan ${fmtImporte(faltaPagar)}.`);
    const usoFavor = c.pagos.filter((x) => x.forma === "saldo_favor").reduce((a, x) => a.plus(dec(x.importe)), new Decimal(0));
    if (usoFavor.gt(saldoFavor)) motivos.push(`El cliente solo tiene ${fmtImporte(saldoFavor)} de saldo a favor.`);
  }
  const puedeGuardar = !guardando && motivos.length === 0;

  // ---------- guardar ----------
  const pagadoPrevio = c.edicion ? dec(c.edicion.pagado) : new Decimal(0);

  const guardarEdicion = async (dif?: { opcion: "devolver" | "saldo_favor"; forma: Forma }) => {
    if (!c.edicion || !puedeGuardar) return;
    if (!dif && total.lt(pagadoPrevio)) {
      setDiferencia({ exceso: pagadoPrevio.minus(total), opcion: c.cliente && !c.cliente.es_publico_general ? "saldo_favor" : "devolver", forma: "efectivo" });
      return;
    }
    setGuardando(true); setMsg(null);
    try {
      const { error } = await supabase().rpc("editar_venta", { p: {
        idempotency_key: c.clave, venta_id: c.edicion.ventaId, comentarios: c.comentarios || null, orden_compra: c.ordenCompra?.trim() || null,
        ...(dif ? { diferencia: dif.opcion, devolucion_forma: dif.forma } : {}),
        partidas: c.lineas.map((l, i) => ({ partida_id: l.partidaId ?? null, producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad,
          precio_unitario: l.precio, descuento: descuentos.porRenglon[i].toFixed(2), entregar_ahora: l.producto.tipo === "servicio" || l.entregarAhora, comentario: l.comentario?.trim() || null,
          descripcion: l.producto.nombre_libre ? l.descripcion?.trim() || null : null,
          almacen_id: almDe(l) })),
      } });
      if (error) {
        if (/editar_venta/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000027_ventas_editables.sql en Supabase.");
        throw error;
      }
      setDiferencia(null);
      router.push(`/ventas/${c.edicion.ventaId}?editada=1`);
    } catch (e) {
      setMsg({ tipo: "error", texto: mensajeError(e) });
      setC((v) => ({ ...v, clave: crypto.randomUUID() }));   // nueva clave para reintentar
    } finally { setGuardando(false); }
  };

  const guardarCotizacion = async () => {
    if (!c.cotizacion || !puedeGuardar) return;
    setGuardando(true); setMsg(null);
    try {
      const publicoSel = !c.cliente || c.cliente.es_publico_general;
      const { data, error } = await supabase().rpc("guardar_cotizacion", { p: {
        id: c.cotizacion.id ?? null, idempotency_key: c.clave, sucursal_id: c.sucursalId, almacen_id: c.almacenId, lista_id: lista?.id,
        cliente_id: publicoSel ? null : c.cliente!.id, prospecto: publicoSel ? (c.cotizacion.prospecto?.trim() || null) : null,
        vigencia: c.cotizacion.vigencia, comentarios: c.comentarios || null, sin_iva: sinIva,
        partidas: c.lineas.map((l, i) => ({ producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad, precio_unitario: l.precio,
          descuento: descuentos.porRenglon[i].toFixed(2), comentario: l.comentario?.trim() || null,
          descripcion: l.producto.nombre_libre ? l.descripcion?.trim() || null : null })),
      } });
      if (error) {
        if (/sin_iva|comentario|guardar_cotizacion/.test(error.message) && /column|columna|function|función/i.test(error.message))
          throw new Error("Falta ejecutar la migración 20261118000037_cotizaciones.sql en Supabase.");
        throw error;
      }
      router.push(`/ventas/cotizaciones/${data.cotizacion_id}?guardada=1`);
    } catch (e) {
      setMsg({ tipo: "error", texto: mensajeError(e) });
      setC((v) => ({ ...v, clave: crypto.randomUUID() }));
    } finally { setGuardando(false); }
  };

  const guardar = async () => {
    if (c.edicion) return guardarEdicion();
    if (c.cotizacion) return guardarCotizacion();
    if (!puedeGuardar) return;
    setGuardando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("confirmar_venta", { p: {
        idempotency_key: c.clave, sucursal_id: c.sucursalId, almacen_id: c.almacenId, lista_id: lista?.id,
        cliente_id: c.cliente?.id ?? null, tipo: c.tipo === "abono" ? "contado" : c.tipo, pago_pendiente: c.tipo === "abono", comentarios: c.comentarios || null, sin_iva: sinIva,
        orden_compra: c.ordenCompra?.trim() || null, cotizacion_id: c.desdeCotizacion?.id ?? null,
        ...(c.cambioAFavor && cambio.gt(0) && c.cliente && !c.cliente.es_publico_general ? { cambio_a_favor: true } : {}),
        partidas: c.lineas.map((l, i) => ({ producto_id: l.producto.id, unidad_venta_id: l.unidadId, cantidad: l.cantidad,
          precio_unitario: l.precio, descuento: descuentos.porRenglon[i].toFixed(2), entregar_ahora: l.producto.tipo === "servicio" || l.entregarAhora,
          descripcion: l.producto.nombre_libre ? l.descripcion?.trim() || null : null,
          ...(l.almacenId && l.almacenId !== c.almacenId ? { almacen_id: l.almacenId } : {}),
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

      {c.cotizacion && (
        <div className="mb-3 rounded px-4 py-2 bg-violet-50 text-violet-900 border border-violet-200 text-sm">
          {c.cotizacion.id ? <>Editando la cotización <b>{c.cotizacion.folio}</b>.</> : <><b>Nueva cotización.</b></>} No mueve inventario ni lleva pagos; después se puede convertir en venta.
        </div>
      )}
      {c.desdeCotizacion && (
        <div className="mb-3 rounded px-4 py-2 bg-sky-50 text-sky-900 border border-sky-200 text-sm">
          Venta desde la cotización <b>{c.desdeCotizacion.folio}</b>: se respetan sus precios y al guardar la cotización queda como convertida.
        </div>
      )}
      {c.edicion && (
        <div className="mb-3 rounded px-4 py-2 bg-sky-50 text-sky-900 border border-sky-200 text-sm">
          Editando la venta <b>{c.edicion.folio}</b>. Al guardar se conserva el folio y el inventario se ajusta por la diferencia.
          Cliente, sucursal, almacén y tipo de venta no se cambian.
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
            {c.cliente && !cambiarCliente && !nuevoCliente ? (
              // Tarjeta del cliente elegido; al pasar el puntero aparece "Editar" para cambiarlo
              <button type="button" disabled={!!c.edicion} title={c.edicion ? "El cliente no se cambia al editar" : "Cambiar cliente"}
                onClick={() => { setCambiarCliente(true); setTextoCliente(""); }}
                className="group relative w-full text-left text-sm rounded px-3 py-2 border border-transparent hover:border-dashed hover:border-[var(--borde)] disabled:cursor-default">
                <div><span className="font-semibold">Nombre:</span> {c.cliente.nombre}</div>
                <div><span className="font-semibold">RFC:</span> {c.cliente.rfc ?? "—"}</div>
                {saldoFavor > 0 && <div className="text-xs text-emerald-700">Saldo a favor: {fmtImporte(saldoFavor)}</div>}
                {!c.edicion && (
                  <span className="absolute inset-0 hidden group-hover:flex items-center justify-center rounded bg-white/75 text-lg" style={{ color: "var(--acento)" }}>Editar</span>
                )}
              </button>
            ) : (
              <>
                <div className="flex gap-2 items-center">
                  <input className="campo text-center" style={{ borderColor: "var(--peligro)", borderStyle: "dashed" }} placeholder="Buscar cliente" value={textoCliente}
                    autoFocus={cambiarCliente} onChange={(e) => setTextoCliente(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Escape") { setCambiarCliente(false); setClientes([]); } }} />
                  <button className="text-xs underline whitespace-nowrap" onClick={() => setNuevoCliente(nuevoCliente ? null : { nombre: textoCliente, rfc: "", telefono: "" })}>+ Nuevo</button>
                </div>
                <div className="flex gap-3 mt-1 text-xs">
                  {publico && c.cliente?.id !== publico.id && (
                    <button className="underline" onClick={() => { setC((v) => ({ ...v, cliente: publico, tipo: v.tipo === "credito" ? "contado" : v.tipo })); setCambiarCliente(false); }}>Público en general</button>
                  )}
                  {c.cliente && cambiarCliente && <button className="underline" onClick={() => { setCambiarCliente(false); setClientes([]); }}>Cancelar</button>}
                </div>
              </>
            )}
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
            {clientes.length > 0 && (
              <ul className="absolute z-10 w-full bg-[var(--panel)] border border-[var(--borde)] shadow max-h-60 overflow-auto">
                {clientes.map((cl) => (
                  <li key={cl.id} className="px-3 py-2 hover:bg-[var(--resalte)] cursor-pointer text-sm"
                    onClick={() => { setC((v) => ({ ...v, cliente: cl })); setTextoCliente(""); setClientes([]); setCambiarCliente(false); }}>
                    {cl.nombre}{cl.rfc ? ` · ${cl.rfc}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="grid gap-3 mt-4 grid-cols-2 lg:grid-cols-5 text-sm">
          <label>Sucursal:
            <select className="campo" value={c.sucursalId} disabled={!!c.edicion} onChange={(e) => {
              const a = sucursales.find((x) => x.id === e.target.value)?.almacen_predeterminado_id ?? almacenes.find((x) => x.sucursal_id === e.target.value)?.id ?? "";
              setC((v) => ({ ...v, sucursalId: e.target.value, almacenId: a }));
            }}>
              {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
            </select>
          </label>
          <label>Almacén:
            <select className="campo" value={c.almacenId} disabled={!!c.edicion} onChange={(e) => setC((v) => ({ ...v, almacenId: e.target.value }))}>
              {almacenesSucursal.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
            </select>
          </label>
          {c.cotizacion ? <>
          <label>Vigencia:
            <input type="date" className="campo" value={c.cotizacion.vigencia} onChange={(e) => setC((v) => ({ ...v, cotizacion: { ...v.cotizacion!, vigencia: e.target.value } }))} />
          </label>
          <label>A nombre de (opcional):
            <input className="campo" placeholder={c.cliente && !c.cliente.es_publico_general ? "Se usa el cliente elegido" : "Nombre del interesado"}
              disabled={!!c.cliente && !c.cliente.es_publico_general} value={c.cotizacion.prospecto ?? ""}
              onChange={(e) => setC((v) => ({ ...v, cotizacion: { ...v.cotizacion!, prospecto: e.target.value } }))} />
          </label>
          </> : <>
          <label>Tipo de venta:
            <select className="campo" value={c.tipo} disabled={!!c.edicion} onChange={(e) => setC((v) => ({ ...v, tipo: e.target.value as Captura["tipo"] }))}>
              {(["contado", "abono", "credito"] as const).map((k) => <option key={k} value={k}>{TIPO_VENTA[k].largo}</option>)}
            </select>
          </label>
          <label>Días de crédito:
            <input className="campo" readOnly value={c.tipo === "credito" ? (c.cliente?.dias_credito ?? 0) : 0} />
          </label>
          <label>Orden de compra:
            <input className="campo" value={c.ordenCompra ?? ""} onChange={(e) => setC((v) => ({ ...v, ordenCompra: e.target.value }))} />
          </label>
          </>}
        </div>

        {!c.cotizacion && c.tipo === "credito" && c.cliente && !c.cliente.es_publico_general && deuda && (() => {
          const cli = c.cliente;
          const limite = Number(cli.limite_credito);
          const nuevo = deuda.debe + total.toNumber();
          const vence = new Date(Date.now() + cli.dias_credito * 86_400_000).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "2-digit", year: "numeric" });
          const problemas = [
            cli.bloqueado && "El cliente está bloqueado para crédito.",
            deuda.vencido > 0 && `Tiene $${fmtImporte(deuda.vencido)} vencido.`,
            limite <= 0 ? "El cliente no tiene límite de crédito (se asigna en su ficha › Crédito)."
              : nuevo > limite && `Con esta venta debería $${fmtImporte(nuevo)} y su límite es $${fmtImporte(limite)}.`,
          ].filter(Boolean) as string[];
          return (
            <div className={`mt-3 rounded px-3 py-2 text-sm ${problemas.length ? "bg-amber-100 text-amber-900" : "bg-[var(--resalte)]"}`}>
              <div>
                Vence el <b>{vence}</b>{cli.dias_credito === 0 && " (0 días: vence hoy)"} · Debe ${fmtImporte(deuda.debe)}
                {limite > 0 && <> · Límite ${fmtImporte(limite)} · Disponible <b>${fmtImporte(Math.max(0, limite - deuda.debe))}</b></>}
                {" · "}<Link className="underline" href={`/ventas/clientes/${cli.id}`} target="_blank">ver crédito del cliente</Link>
              </div>
              {problemas.map((m) => <div key={m}>⚠ {m}</div>)}
              {problemas.length > 0 && <div className="text-xs mt-1">{puedeAutorizar ? "Tienes permiso para autorizarla de todos modos." : "Solo un gerente o administrador puede autorizar esta venta a crédito."}</div>}
            </div>
          );
        })()}

        {/* Partidas */}
        <div className="overflow-x-auto mt-4">
          <table className="w-full text-sm min-w-[760px]">
            <thead style={{ color: "var(--acento)" }}>
              <tr className="text-left">
                <th className="py-1 pl-2 pr-3 font-normal w-32">Código</th><th className="font-normal w-28 pr-3">Unidad</th><th className="font-normal pr-3">Concepto</th>
                <th className="font-normal w-24">Cant.</th><th className="font-normal w-28">Precio</th>
                {conDescuento && <th className="font-normal w-36">Descuento</th>}
                <th className="font-normal w-28 text-right pr-3">Importe</th><th className="w-40"></th>
              </tr>
            </thead>
            <tbody>
              {c.lineas.map((l, i) => {
                const u = l.producto.unidades.find((x) => x.id === l.unidadId) as UnidadVenta;
                const almL = almDe(l);
                const ex = existencias[claveEx(l.producto.id, almL)];
                const exU = ex === undefined ? null : new Decimal(ex).div(u.factor);
                const tot = existTotal[claveEx(l.producto.id, almL)];
                const totU = tot === undefined ? null : new Decimal(tot).div(u.factor);
                const sinEx = l.producto.tipo === "producto" && ex !== undefined && aBase(l.cantidad || 0, u.factor).gt(ex);
                const invalida = !cantidadValida(l.cantidad || 0, l.producto.permite_fraccion, u.factor);
                const med = medida(l.producto);
                return (
                  <tr key={l.uid} className="border-t border-[var(--borde)] align-top" style={{ background: i % 2 ? "transparent" : "#f7f9fb" }}>
                    <td className="py-2 pl-2 pr-3 whitespace-nowrap">{l.producto.sku}</td>
                    <td className="py-1 pr-3">
                      <select className="campo" value={l.unidadId} onChange={(e) => {
                        const nu = l.producto.unidades.find((x) => x.id === e.target.value)!;
                        editar(l.uid, { unidadId: nu.id, precio: nu.precio ?? "0" });
                      }}>
                        {l.producto.unidades.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                      </select>
                      {l.producto.tipo === "producto" && !c.cotizacion && (
                        <label className="block mt-1 text-xs text-[var(--tenue)]" title="Bodega de donde sale este producto">Sale de
                          <select className={`campo !py-0.5 text-xs ${almL !== c.almacenId ? "!border-[var(--acento)] font-semibold" : ""}`} value={almL}
                            disabled={Number(l.entregada) > 0}
                            onChange={(e) => { const a = e.target.value; editar(l.uid, { almacenId: a === c.almacenId ? undefined : a }); cargarExistencias([l.producto.id], a); }}>
                            {almacenes.map((a) => <option key={a.id} value={a.id}>{a.nombre}</option>)}
                          </select>
                        </label>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {l.producto.nombre_libre ? (
                        <input className={`campo ${l.descripcion?.trim() ? "" : "campo-requerido"}`} placeholder={`Nombre del concepto (${l.producto.nombre})`}
                          value={l.descripcion ?? ""} onChange={(e) => editar(l.uid, { descripcion: e.target.value })} autoFocus={!l.partidaId && !l.descripcion} />
                      ) : nombreConCaja(l.producto.nombre, l.producto.m2_por_caja, l.producto.formato)}
                      {l.producto.tipo === "servicio" && <span className="ml-1 px-1.5 rounded text-[10px] bg-sky-100 text-sky-900 align-middle">Sin inventario</span>}
                      <button className="ml-2 align-middle inline-flex items-center justify-center w-6 h-5 border rounded border-[var(--acento)] text-[var(--acento)]" title="Ver detalle y existencia por almacén"
                        aria-label="Ver detalle del producto" onClick={() => verDetalle(l.producto)}>
                        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
                      </button>
                      {l.producto.tipo === "producto" && exU && (
                        <div className={`text-xs mt-1 ${exU.lt(0) || sinEx ? "text-[var(--peligro)] font-semibold" : "text-[var(--tenue)]"}`}>
                          {totU && <>Exist.: {fmtCantidad(totU, 2)} {u.nombre}{(!u.es_base || med.unidad !== l.producto.unidad_base) && u.nombre !== med.unidad && <> ({fmtCantidad(new Decimal(tot!).times(med.porBase), 2)} {med.unidad})</>} · </>}
                          Disp.: {fmtCantidad(exU, 2)} {u.nombre}
                          {(!u.es_base || med.unidad !== l.producto.unidad_base) && u.nombre !== med.unidad && <> ({fmtCantidad(new Decimal(ex!).times(med.porBase), 2)} {med.unidad})</>}
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
                    <td className="py-1"><input className={`campo ${l.producto.precio_libre && l.precio === "" ? "campo-requerido" : ""}`} inputMode="decimal"
                      placeholder={l.producto.precio_libre ? "Precio" : undefined} value={l.precio} onChange={(e) => editar(l.uid, { precio: e.target.value })} /></td>
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
                    <td className="py-2 pr-3 text-right whitespace-nowrap font-medium">{importes[i] ? fmtImporte(importes[i]!.total) : "—"}</td>
                    <td className="py-1.5">
                      <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
                        <BotonIcono activo={!!l.verDesc || Number(l.descValor) > 0} titulo="Descuento del renglón" onClick={() => editar(l.uid, { verDesc: !l.verDesc })}>
                          {/* etiqueta */}
                          <path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9Z" /><circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" stroke="none" />
                        </BotonIcono>
                        <BotonIcono activo={!!l.verComent || !!l.comentario} titulo="Comentario del renglón" onClick={() => editar(l.uid, { verComent: !l.verComent })}>
                          {/* globo de comentario */}
                          <path d="M4 5h16v11H9l-5 4V5Z" />
                        </BotonIcono>
                        {!c.cotizacion && <label title="Se entrega ahora (desmarca si se entrega después)" className="flex items-center gap-1 text-xs mx-1 cursor-pointer">
                          <input type="checkbox" checked={l.entregarAhora} onChange={(e) => editar(l.uid, { entregarAhora: e.target.checked })} /> Ent.
                        </label>}
                        <button aria-label="Quitar partida" title={Number(l.entregada) > 0 ? "No se puede quitar: ya se entregó material" : "Quitar partida"}
                          disabled={Number(l.entregada) > 0} className="w-7 h-7 rounded-full text-white flex items-center justify-center disabled:opacity-40"
                          style={{ background: "var(--peligro)" }} onClick={() => setC((v) => ({ ...v, lineas: v.lineas.filter((x) => x.uid !== l.uid) }))}>
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
                        </button>
                      </div>
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
                      className="px-3 py-1.5 cursor-pointer text-sm hover:bg-[var(--resalte)] flex items-center gap-2"
                      style={i === 0 ? { background: "var(--acento)", color: "white" } : undefined}>
                      {p.imagen_url
                        ? <img src={p.imagen_url} alt="" loading="lazy" className="w-8 h-8 object-cover rounded bg-white shrink-0" />
                        : <span className="w-8 h-8 shrink-0" />}
                      <span>{p.sku} - {nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}</span>
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
        <div className="barra-seccion mt-6">{c.cotizacion ? "Comentarios y totales" : "Pagos"}</div>
        <div className="grid gap-6 lg:grid-cols-[1fr_280px] mt-3">
          <div className="flex flex-col gap-3 text-sm">
            {c.edicion && (
              <div className="rounded px-3 py-2 bg-[var(--resalte)]">
                Ya pagado: <b>{fmtImporte(pagadoPrevio)}</b>. Si el total sube, la diferencia queda como saldo y se cobra con <b>Registrar pago</b>.
                Si baja de lo pagado, al guardar se pregunta si se devuelve o queda a favor.
              </div>
            )}
            {!c.edicion && !c.cotizacion && saldoFavor > 0 && (
              <div className="rounded px-3 py-2 bg-emerald-50 text-emerald-900">
                El cliente tiene <b>{fmtImporte(saldoFavor)}</b> de saldo a favor. Úsalo eligiendo la forma de pago “Saldo a favor”.
              </div>
            )}
            {!c.edicion && !c.cotizacion && c.pagos.map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_120px] sm:grid-cols-[180px_140px_1fr_auto] gap-2 items-center">
                <select className="campo" value={p.forma} onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, forma: e.target.value as Forma } : x)) }))}>
                  {Object.entries(FORMAS).filter(([k]) => k !== "saldo_favor" || saldoFavor > 0 || p.forma === k).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                </select>
                <input className="campo" inputMode="decimal" placeholder={pagoAutomatico && i === 0 ? `${fmtImporte(total)} (total)` : c.tipo === "abono" ? "Abono" : "Importe"} value={p.importe}
                  onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, importe: e.target.value } : x)) }))} />
                <input className="campo col-span-2 sm:col-span-1" placeholder={p.forma === "efectivo" ? "Referencia (opcional)" : "Referencia / últimos 4 dígitos / autorización"} value={p.referencia}
                  onChange={(e) => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === i ? { ...x, referencia: e.target.value } : x)) }))} />
                {c.pagos.length > 1 && (
                  <button className="text-[var(--peligro)]" aria-label="Quitar pago" onClick={() => setC((v) => ({ ...v, pagos: v.pagos.filter((_, j) => j !== i) }))}>✕</button>
                )}
              </div>
            ))}
            {!c.edicion && !c.cotizacion && <div className="flex gap-4">
              <button className="underline" onClick={() => setC((v) => ({ ...v, pagos: [...v.pagos, { forma: "tarjeta_debito", importe: faltaPagar.gt(0) ? faltaPagar.toFixed(2) : "", referencia: "" }] }))}>+ Agregar forma de pago</button>
              <button className="underline" onClick={() => setC((v) => ({ ...v, pagos: v.pagos.map((x, j) => (j === 0 ? { ...x, importe: total.toFixed(2) } : x)) }))}>Pagar el total</button>
            </div>}
            <label className="mt-2">Comentarios
              <textarea className="campo h-20" value={c.comentarios} onChange={(e) => setC((v) => ({ ...v, comentarios: e.target.value }))} />
            </label>
          </div>

          <div className="text-sm">
            <dl className="grid grid-cols-[1fr_auto] gap-y-1">
              <dt>Subtotal:</dt><dd className="text-right">{fmtImporte(subtotal.plus(descuento))}</dd>
              <dt className="flex items-center gap-1">Descuento
                <select className="campo !w-14 !px-1 !py-0.5" value={c.descGlobalTipo ?? "$"} onChange={(e) => setC((v) => ({ ...v, descGlobalTipo: e.target.value as TipoDesc }))}>
                  <option value="$">$</option><option value="%">%</option>
                </select>
                <input className="campo !w-20 !py-0.5 text-right" inputMode="decimal" placeholder="0" value={c.descGlobalValor ?? ""}
                  onChange={(e) => setC((v) => ({ ...v, descGlobalValor: e.target.value }))} />
              </dt><dd className="text-right self-center">{fmtImporte(descuento)}</dd>
              <dt>
                I.V.A.:
                <label className="ml-2 text-xs whitespace-nowrap" title="Desmarca solo si la venta debe llevar IVA">
                  <input type="checkbox" checked={sinIva} onChange={(e) => setC((v) => ({ ...v, sinIva: e.target.checked }))} /> Sin IVA
                </label>
              </dt><dd className="text-right">{fmtImporte(iva)}</dd>
              <dt className="font-semibold text-base">Total (MXN):</dt><dd className="text-right font-semibold text-base">{fmtImporte(total)}</dd>
              {c.cotizacion ? null : c.edicion ? <>
                <dt className="mt-2">Ya pagado:</dt><dd className="text-right mt-2">{fmtImporte(pagadoPrevio)}</dd>
                {total.gte(pagadoPrevio)
                  ? <><dt>Saldo pendiente:</dt><dd className="text-right font-semibold">{fmtImporte(total.minus(pagadoPrevio))}</dd></>
                  : <><dt>Pagado de más:</dt><dd className="text-right font-semibold text-amber-700">{fmtImporte(pagadoPrevio.minus(total))}</dd></>}
              </> : <>
              <dt className="mt-2">Pagado:</dt><dd className="text-right mt-2">{fmtImporte(pagado)}</dd>
              {c.tipo === "contado"
                ? <><dt>Cambio:</dt><dd className="text-right font-semibold">{c.cambioAFavor && cambio.gt(0) ? <s className="text-[var(--tenue)]">{fmtImporte(cambio)}</s> : fmtImporte(cambio)}</dd>
                  {cambio.gt(0) && c.cliente && !c.cliente.es_publico_general && (
                    <dd className="col-span-2 text-right text-xs">
                      <label className="cursor-pointer"><input type="checkbox" checked={!!c.cambioAFavor} onChange={(e) => setC((v) => ({ ...v, cambioAFavor: e.target.checked }))} />{" "}
                        Dejar el cambio ({fmtImporte(cambio)}) como saldo a favor</label>
                    </dd>
                  )}</>
                : <><dt>{c.tipo === "abono" ? "Saldo pendiente:" : "Saldo a crédito:"}</dt><dd className="text-right font-semibold">{fmtImporte(faltaPagar)}</dd></>}
              </>}
            </dl>
            <div className="flex justify-end gap-2 mt-4">
              {c.cotizacion?.id
                ? <button className="px-3 py-2 underline" onClick={() => router.push(`/ventas/cotizaciones/${c.cotizacion!.id}`)}>Cancelar edición</button>
                : c.edicion
                ? <button className="px-3 py-2 underline" onClick={() => router.push(`/ventas/${c.edicion!.ventaId}`)}>Cancelar edición</button>
                : <button className="px-3 py-2 underline" onClick={() => { if (window.confirm("¿Descartar esta captura?")) setC(capturaNueva(c.sucursalId, c.almacenId, publico)); }}>Descartar</button>}
              <button className="btn-primario" title="F9" disabled={!puedeGuardar} onClick={guardar}>{guardando ? "Guardando…" : c.cotizacion ? (c.cotizacion.id ? "Guardar cambios" : "Guardar cotización") : c.edicion ? "Guardar cambios" : "Guardar"}</button>
            </div>
            {motivos.length > 0 && !guardando && (
              <ul className="text-xs text-[var(--peligro)] mt-2 text-right">
                {motivos.map((m) => <li key={m}>{m}</li>)}
              </ul>
            )}
          </div>
        </div>
      </section>

      {diferencia && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setDiferencia(null)}>
          <div role="dialog" aria-label="Pagado de más" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">El cliente pagó de más</h2>
            <p className="mt-2">Con los cambios, la venta queda en <b>{fmtImporte(total)}</b> y ya había pagado <b>{fmtImporte(pagadoPrevio)}</b>.
              ¿Qué se hace con la diferencia de <b>{fmtImporte(diferencia.exceso)}</b>?</p>
            <label className="flex items-center gap-2 mt-3">
              <input type="radio" checked={diferencia.opcion === "devolver"} onChange={() => setDiferencia({ ...diferencia, opcion: "devolver" })} /> Devolverle el dinero
            </label>
            {diferencia.opcion === "devolver" && (
              <select className="campo mt-1 ml-6 !w-auto" value={diferencia.forma} onChange={(e) => setDiferencia({ ...diferencia, forma: e.target.value as Forma })}>
                <option value="efectivo">En efectivo</option><option value="transferencia">Por transferencia</option>
                <option value="tarjeta_debito">A tarjeta de débito</option><option value="tarjeta_credito">A tarjeta de crédito</option>
              </select>
            )}
            <label className={`flex items-center gap-2 mt-2 ${!c.cliente || c.cliente.es_publico_general ? "opacity-50" : ""}`}>
              <input type="radio" disabled={!c.cliente || c.cliente.es_publico_general} checked={diferencia.opcion === "saldo_favor"}
                onChange={() => setDiferencia({ ...diferencia, opcion: "saldo_favor" })} /> Dejarlo como saldo a favor del cliente
              {(!c.cliente || c.cliente.es_publico_general) && <span className="text-xs">(no aplica a Público en general)</span>}
            </label>
            <div className="flex justify-end gap-3 mt-5">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setDiferencia(null)}>Volver</button>
              <button className="btn-primario" disabled={guardando} onClick={() => guardarEdicion({ opcion: diferencia.opcion, forma: diferencia.forma })}>
                {guardando ? "Guardando…" : "Guardar cambios"}</button>
            </div>
          </div>
        </div>
      )}

      {detalle && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setDetalle(null)}>
          <div role="dialog" aria-label="Detalle del producto" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-xl p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-3">
              <h2 className="text-lg font-semibold">{detalle.producto.sku} · {nombreConCaja(detalle.producto.nombre, detalle.producto.m2_por_caja, detalle.producto.formato)}</h2>
              <button aria-label="Cerrar" className="text-[var(--peligro)] text-lg" onClick={() => setDetalle(null)}>✕</button>
            </div>
            <div className="text-[var(--tenue)] mt-1">
              Inventario en {detalle.producto.unidad_base}
              {detalle.producto.piezas_por_caja && detalle.producto.m2_por_caja && <> · Caja: {detalle.producto.piezas_por_caja} piezas = {fmtCantidad(detalle.producto.m2_por_caja, 4)} m²</>}
            </div>
            {detalle.producto.imagen_url && (
              <a href={detalle.producto.imagen_url} target="_blank" rel="noreferrer" title="Ver foto completa">
                <img src={detalle.producto.imagen_url} alt={`Foto de ${detalle.producto.nombre}`} className="mt-3 w-full max-h-64 object-contain rounded border border-[var(--borde)] bg-white" />
              </a>
            )}
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

/** Botón redondo con icono (gris; azul cuando está en uso). */
function BotonIcono({ activo, titulo, onClick, children }: { activo: boolean; titulo: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" title={titulo} aria-label={titulo} aria-pressed={activo} onClick={onClick}
      className="w-7 h-7 rounded-full text-white flex items-center justify-center" style={{ background: activo ? "var(--acento)" : "#7a7a7a" }}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">{children}</svg>
    </button>
  );
}
