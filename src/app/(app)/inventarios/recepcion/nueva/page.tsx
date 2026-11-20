"use client";
/**
 * Nueva recepción de mercancía: almacén, proveedor, documento del proveedor (factura/remisión, número,
 * fecha, días de crédito) y renglones (producto, unidad, cantidad, costo sin IVA y tasa de IVA), con
 * descuento global. Se guarda con registrar_entrada.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtCantidad, fmtImporte, nombreConCaja } from "@/lib/unidades";
import { DialogoProveedor } from "@/components/DialogoProveedor";

interface Unidad { id: string; nombre: string; factor: string; es_base: boolean; orden: number }
interface Producto {
  id: string; sku: string; nombre: string; unidad_base: string; ultimo_costo: string; imagen_url: string | null;
  m2_por_caja: string | null; formato: string | null; unidades_venta: Unidad[];
}
interface Renglon { uid: string; producto: Producto; unidadId: string; cantidad: string; costo: string; iva: string }
const num = (v: string) => { const n = Number(String(v).replace(/[$,\s]/g, "")); return Number.isFinite(n) ? n : 0; };

export default function NuevaRecepcion() {
  const router = useRouter();
  const [almacenes, setAlmacenes] = useState<{ id: string; nombre: string; suc: string }[]>([]);
  const [proveedores, setProveedores] = useState<{ id: string; nombre: string; dias_credito: number }[]>([]);
  const [tipoDoc, setTipoDoc] = useState<"factura" | "remision" | "otro">("factura");
  const [fechaDoc, setFechaDoc] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }));
  const [diasCredito, setDiasCredito] = useState("0");
  const [desc, setDesc] = useState<{ tipo: "$" | "%"; valor: string }>({ tipo: "$", valor: "" });
  const [almacen, setAlmacen] = useState("");
  const [proveedor, setProveedor] = useState("");
  const [documento, setDocumento] = useState("");
  const [comentarios, setComentarios] = useState("");
  const [renglones, setRenglones] = useState<Renglon[]>([]);
  const [texto, setTexto] = useState("");
  const [resultados, setResultados] = useState<Producto[]>([]);
  const [nuevoProv, setNuevoProv] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [clave] = useState(() => crypto.randomUUID());

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      const [mis, al, pr] = await Promise.all([
        sb.from("usuario_sucursales").select("sucursal_id").eq("user_id", user?.id ?? ""),
        sb.from("almacenes").select("id, nombre, sucursal_id, sucursales!almacenes_sucursal_id_fkey(codigo)").eq("activo", true).order("nombre"),
        sb.from("proveedores").select("id, nombre, dias_credito").eq("activo", true).order("nombre"),
      ]);
      const sucs = new Set(((mis.data ?? []) as { sucursal_id: string }[]).map((x) => x.sucursal_id));
      const lista = ((al.data ?? []) as unknown as { id: string; nombre: string; sucursal_id: string; sucursales: { codigo: string } | null }[])
        .filter((a) => !sucs.size || sucs.has(a.sucursal_id)).map((a) => ({ id: a.id, nombre: a.nombre, suc: a.sucursales?.codigo ?? "" }));
      setAlmacenes(lista);
      setAlmacen(lista[0]?.id ?? "");
      setProveedores((pr.data ?? []) as { id: string; nombre: string; dias_credito: number }[]);
    })();
  }, []);

  // Búsqueda de productos (solo inventariables)
  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (!t) { setResultados([]); return; }
    const h = setTimeout(async () => {
      const { data, error } = await supabase().from("productos")
        .select("id, sku, nombre, unidad_base, ultimo_costo, imagen_url, m2_por_caja, formato, unidades_venta(id, nombre, factor, es_base, orden)")
        .eq("activo", true).eq("tipo", "producto").or(`sku.ilike.%${t}%,nombre.ilike.%${t}%,codigo_barras.eq.${t}`).order("sku").limit(20);
      if (error) { setMsg(mensajeError(error)); return; }
      setResultados((data ?? []) as Producto[]);
    }, 200);
    return () => clearTimeout(h);
  }, [texto]);

  const agregar = (p: Producto) => {
    const us = [...p.unidades_venta].sort((a, b) => a.orden - b.orden);
    const u = us.find((x) => x.nombre === "CAJA") ?? us.find((x) => x.es_base) ?? us[0];
    const costo = Number(p.ultimo_costo) > 0 ? String(Math.round(Number(p.ultimo_costo) * Number(u.factor) * 10000) / 10000) : "";
    setRenglones((r) => [...r, { uid: crypto.randomUUID(), producto: { ...p, unidades_venta: us }, unidadId: u.id, cantidad: "", costo,
      iva: tipoDoc === "factura" ? "0.16" : "0" }]);
    setTexto(""); setResultados([]);
  };
  const editar = (uid: string, cambios: Partial<Renglon>) => setRenglones((r) => r.map((x) => (x.uid === uid ? { ...x, ...cambios } : x)));
  // Totales como en la base: subtotal, descuento global (repartido), IVA por renglón sobre el importe con descuento
  const t = useMemo(() => {
    const sub = renglones.reduce((s, r) => s + Math.round(num(r.cantidad) * num(r.costo) * 100) / 100, 0);
    const d = Math.min(sub, Math.round((desc.tipo === "%" ? sub * num(desc.valor) / 100 : num(desc.valor)) * 100) / 100);
    const k = sub > 0 ? (sub - d) / sub : 1;
    const iva = renglones.reduce((s, r) => s + Math.round(num(r.cantidad) * num(r.costo) * k * num(r.iva) * 100) / 100, 0);
    return { sub, d, iva, total: sub - d + iva };
  }, [renglones, desc]);

  const faltan = [
    !almacen && "Elige el almacén.",
    !renglones.length && "Agrega al menos un producto.",
    ...renglones.filter((r) => !(num(r.cantidad) > 0)).map((r) => `${r.producto.sku}: escribe la cantidad.`),
    ...renglones.filter((r) => r.costo === "" || num(r.costo) < 0).map((r) => `${r.producto.sku}: escribe el costo.`),
  ].filter(Boolean) as string[];

  const guardar = async () => {
    if (faltan.length) { setMsg(faltan.join(" ")); return; }
    setGuardando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("registrar_entrada", { p: {
        idempotency_key: clave, almacen_id: almacen, proveedor_id: proveedor || null, documento_proveedor: documento.trim() || null,
        comentarios: comentarios.trim() || null, tipo_documento: tipoDoc, fecha_documento: fechaDoc || null,
        dias_credito: Number(diasCredito) || 0, descuento: t.d,
        partidas: renglones.map((r) => ({ producto_id: r.producto.id, unidad_venta_id: r.unidadId, cantidad: num(r.cantidad), costo_unitario: num(r.costo), iva_tasa: num(r.iva) })),
      } });
      if (error) {
        if (/serie activa/.test(error.message)) throw new Error("Falta ejecutar la migración 20261120000047_recepcion_mercancia.sql en Supabase (crea la serie de entradas).");
        throw error;
      }
      router.push(`/inventarios/recepcion/${data.entrada_id}?nueva=1`);
    } catch (e) { setMsg(mensajeError(e)); setGuardando(false); }
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Nueva recepción de mercancía</h1>
        <Link href="/inventarios/recepcion" className="underline text-sm">← Volver</Link>
      </div>
      {msg && <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm items-end">
        <label>Almacén que recibe
          <select className="campo" value={almacen} onChange={(e) => setAlmacen(e.target.value)}>
            {almacenes.map((a) => <option key={a.id} value={a.id}>{a.suc ? `${a.suc} · ` : ""}{a.nombre}</option>)}
          </select>
        </label>
        <label>Proveedor
          <div className="flex gap-1">
            <select className="campo" value={proveedor} onChange={(e) => { setProveedor(e.target.value); setDiasCredito(String(proveedores.find((x) => x.id === e.target.value)?.dias_credito ?? 0)); }}>
              <option value="">Sin proveedor</option>
              {proveedores.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
            </select>
            <button type="button" className="px-2 rounded border border-[var(--borde)] whitespace-nowrap" onClick={() => setNuevoProv(true)}>+ Nuevo</button>
          </div>
        </label>
        <label>Tipo de documento
          <select className="campo" value={tipoDoc} onChange={(e) => setTipoDoc(e.target.value as typeof tipoDoc)}>
            <option value="factura">Factura</option><option value="remision">Remisión</option><option value="otro">Otro</option>
          </select>
        </label>
        <label>No. de documento<input className="campo" value={documento} onChange={(e) => setDocumento(e.target.value)} placeholder="p. ej. A-1234" /></label>
        <label>Fecha del documento<input type="date" className="campo" value={fechaDoc} onChange={(e) => setFechaDoc(e.target.value)} /></label>
        <label>Días de crédito<input className="campo" inputMode="numeric" value={diasCredito} onChange={(e) => setDiasCredito(e.target.value)} /></label>
        <label className="sm:col-span-2">Comentarios<input className="campo" value={comentarios} onChange={(e) => setComentarios(e.target.value)} /></label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-3">
        <div className="relative max-w-xl">
          <input className="campo" placeholder="Buscar producto por SKU, nombre o código de barras" value={texto} onChange={(e) => setTexto(e.target.value)} />
          {resultados.length > 0 && (
            <ul className="absolute z-20 left-0 right-0 mt-1 bg-white border border-[var(--borde)] rounded shadow max-h-72 overflow-auto">
              {resultados.map((p) => (
                <li key={p.id} className="px-3 py-1.5 cursor-pointer text-sm hover:bg-[var(--resalte)] flex items-center gap-2" onClick={() => agregar(p)}>
                  {p.imagen_url ? <img src={p.imagen_url} alt="" className="w-8 h-8 object-cover rounded" /> : <span className="w-8 h-8" />}
                  <span>{p.sku} - {nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[760px]">
            <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
              <th className="py-1 font-normal">Producto</th><th className="font-normal w-32">Unidad</th><th className="font-normal w-28">Cantidad</th>
              <th className="font-normal w-36">Costo unitario (sin IVA)</th><th className="font-normal w-24">IVA</th><th className="font-normal w-32 text-right">Importe</th><th className="w-8" /></tr></thead>
            <tbody>
              {renglones.map((r) => {
                const u = r.producto.unidades_venta.find((x) => x.id === r.unidadId)!;
                const base = num(r.cantidad) * Number(u.factor);
                return (
                  <tr key={r.uid} className="border-b border-[var(--borde)] align-top">
                    <td className="py-2 pr-3">{r.producto.sku} · {nombreConCaja(r.producto.nombre, r.producto.m2_por_caja, r.producto.formato)}
                      {!u.es_base && num(r.cantidad) > 0 && <div className="text-xs text-[var(--tenue)]">= {fmtCantidad(base, 4)} {r.producto.unidad_base}</div>}</td>
                    <td className="py-1 pr-2">
                      <select className="campo" value={r.unidadId} onChange={(e) => {
                        const nu = r.producto.unidades_venta.find((x) => x.id === e.target.value)!;
                        // conserva el costo por unidad base al cambiar de unidad
                        const costo = r.costo === "" ? "" : String(Math.round(num(r.costo) / Number(u.factor) * Number(nu.factor) * 10000) / 10000);
                        editar(r.uid, { unidadId: nu.id, costo });
                      }}>
                        {r.producto.unidades_venta.map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}
                      </select>
                    </td>
                    <td className="py-1 pr-2"><input className={`campo ${num(r.cantidad) > 0 ? "" : "campo-requerido"}`} inputMode="decimal" autoFocus value={r.cantidad} onChange={(e) => editar(r.uid, { cantidad: e.target.value })} /></td>
                    <td className="py-1 pr-2"><input className={`campo ${r.costo === "" ? "campo-requerido" : ""}`} inputMode="decimal" value={r.costo} onChange={(e) => editar(r.uid, { costo: e.target.value })} /></td>
                    <td className="py-1 pr-2">
                      <select className="campo" value={r.iva} onChange={(e) => editar(r.uid, { iva: e.target.value })}>
                        <option value="0.16">16%</option><option value="0.08">8%</option><option value="0">0%</option>
                      </select>
                    </td>
                    <td className="py-2 text-right whitespace-nowrap">${fmtImporte(num(r.cantidad) * num(r.costo))}</td>
                    <td className="py-1 text-right"><button aria-label="Quitar renglón" className="text-[var(--peligro)]" onClick={() => setRenglones((x) => x.filter((y) => y.uid !== r.uid))}>✕</button></td>
                  </tr>
                );
              })}
              {!renglones.length && <tr><td colSpan={7} className="py-6 text-center text-[var(--tenue)]">Busca los productos que llegaron y agrégalos.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex justify-between items-center flex-wrap gap-3">
          <span className="text-sm text-[var(--tenue)] max-w-md">El costo sin IVA (con el descuento repartido) se usa para el costo promedio, el valor del inventario y la utilidad de las ventas.</span>
          <div className="flex flex-col items-end gap-1 text-sm">
            <div className="flex gap-6"><span>Subtotal</span><span className="w-28 text-right">${fmtImporte(t.sub)}</span></div>
            <div className="flex gap-2 items-center">Descuento
              <select className="campo !w-14 !px-1 !py-0.5" value={desc.tipo} onChange={(e) => setDesc({ ...desc, tipo: e.target.value as "$" | "%" })}><option value="$">$</option><option value="%">%</option></select>
              <input className="campo !w-24 !py-0.5 text-right" inputMode="decimal" placeholder="0" value={desc.valor} onChange={(e) => setDesc({ ...desc, valor: e.target.value })} />
              <span className="w-28 text-right">−${fmtImporte(t.d)}</span></div>
            <div className="flex gap-6"><span>I.V.A.</span><span className="w-28 text-right">${fmtImporte(t.iva)}</span></div>
            <div className="flex gap-6 text-lg font-semibold"><span>Total</span><span className="w-28 text-right">${fmtImporte(t.total)}</span></div>
            <button className="btn-primario mt-2" disabled={guardando} onClick={guardar}>{guardando ? "Guardando…" : "Registrar recepción"}</button>
          </div>
        </div>
      </section>

      {nuevoProv && (
        <DialogoProveedor alCerrar={() => setNuevoProv(false)} alGuardar={(id, nombre) => {
          setProveedores((p) => [...p, { id, nombre, dias_credito: 0 }].sort((a, b) => a.nombre.localeCompare(b.nombre)));
          setProveedor(id); setNuevoProv(false);
        }} />
      )}
    </div>
  );
}
