"use client";
/** Formulario de alta/edición de producto (pisos por caja/pieza con precio por m², u otros por unidad). */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { mxnPrecio } from "@/lib/unidades";
import { PRODUCTO_VACIO, ProductoForm as Datos, UNIDADES, aPayload, areaFormato, prefijoSku, preciosPiso, validar } from "@/lib/productos";

export default function ProductoForm({ inicial, esNuevo }: { inicial?: Datos; esNuevo: boolean }) {
  const router = useRouter();
  const [f, setF] = useState<Datos>(inicial ?? PRODUCTO_VACIO);
  const [marcas, setMarcas] = useState<string[]>([]);
  const [categorias, setCategorias] = useState<string[]>([]);
  const [manualCaja, setManualCaja] = useState(!!(inicial?.precio_caja));
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [intento, setIntento] = useState(false);
  const [almacenes, setAlmacenes] = useState<{ id: string; nombre: string; suc: string }[]>([]);
  const [ex, setEx] = useState({ almacen: "", cajas: "", sueltas: "", cantidad: "" });

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const [m, c, a] = await Promise.all([sb.from("marcas").select("nombre").order("nombre"), sb.from("categorias").select("nombre").order("nombre"),
        sb.from("almacenes").select("id, nombre, activo, sucursales(codigo)").eq("activo", true).order("nombre")]);
      const al = ((a.data ?? []) as unknown as { id: string; nombre: string; sucursales: { codigo: string } | null }[])
        .map((x) => ({ id: x.id, nombre: x.nombre, suc: x.sucursales?.codigo ?? "" }));
      setAlmacenes(al);
      if (al.length === 1) setEx((e) => ({ ...e, almacen: al[0].id }));
      setMarcas(((m.data ?? []) as { nombre: string }[]).map((x) => x.nombre));
      setCategorias(((c.data ?? []) as { nombre: string }[]).map((x) => x.nombre));
    })();
  }, []);

  const set = <K extends keyof Datos>(k: K, v: Datos[K]) => setF((x) => ({ ...x, [k]: v }));
  const calc = preciosPiso(f.m2_por_caja, f.piezas_por_caja, f.precio_m2);
  const errores = validar(f);

  const guardar = async (otro: boolean) => {
    setIntento(true); setMsg(null);
    if (errores.length) return;
    setGuardando(true);
    try {
      const p = aPayload(manualCaja ? f : { ...f, precio_caja: "", precio_pieza: "" });
      const conExistencia = esNuevo && [ex.cajas, ex.sueltas, ex.cantidad].some((v) => Number(v) > 0);
      if (conExistencia && !ex.almacen) throw new Error("Elige el almacén de la existencia inicial.");
      let data: { sku: string };
      if (conExistencia) {
        // Producto + existencia inicial en una sola operación (todo o nada)
        const r = await supabase().rpc("importar_productos", { p: { idempotency_key: crypto.randomUUID(), almacen_id: ex.almacen,
          filas: [{ fila: 1, ...p, cajas: ex.cajas || null, piezas_sueltas: ex.sueltas || null, cantidad: ex.cantidad || null }] } });
        if (r.error) throw r.error;
        data = { sku: r.data.productos?.[0]?.sku ?? "" };
      } else {
        const r = await supabase().rpc("guardar_producto", { p });
        if (r.error) throw r.error;
        data = r.data;
      }
      setEx((e) => ({ ...e, cajas: "", sueltas: "", cantidad: "" }));
      if (otro) {
        // Siguiente producto con la misma marca, categoría, formato y tipo
        setF({ ...PRODUCTO_VACIO, marca: f.marca, categoria: f.categoria, formato: f.formato, presentacion: f.presentacion,
          unidad: f.unidad, piezas_por_caja: f.piezas_por_caja, m2_por_caja: f.m2_por_caja, precio_m2: f.precio_m2 });
        setIntento(false);
        setMsg({ tipo: "ok", texto: `Producto ${data.sku} guardado. Captura el siguiente.` });
        if (f.marca && !marcas.includes(f.marca)) setMarcas((m) => [...m, f.marca].sort());
        if (f.categoria && !categorias.includes(f.categoria)) setCategorias((c) => [...c, f.categoria].sort());
      } else {
        router.push(`/compras/productos?guardado=${encodeURIComponent(data.sku)}`);
      }
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setGuardando(false); }
  };

  /** Elimina si nunca se usó; si ya tiene historial ofrece desactivarlo. */
  const eliminar = async () => {
    if (!f.id || !window.confirm(`¿Eliminar el producto ${f.sku} · ${f.nombre}? No se puede deshacer.`)) return;
    setGuardando(true); setMsg(null);
    try {
      const { error } = await supabase().rpc("eliminar_producto", { p: { id: f.id } });
      if (error) {
        if (/historial|movimientos|documentos|ya se usó/i.test(error.message) && f.activo
            && window.confirm(`${error.message}

¿Lo desactivo ahora?`)) {
          const r = await supabase().rpc("guardar_producto", { p: { ...aPayload(manualCaja ? f : { ...f, precio_caja: "", precio_pieza: "" }), activo: false } });
          if (r.error) throw r.error;
          router.push(`/compras/productos?guardado=${encodeURIComponent(f.sku)}`);
          return;
        }
        if (/eliminar_producto/.test(error.message)) throw new Error("Falta ejecutar la migración 20261113000017_eliminar_producto.sql en Supabase.");
        throw error;
      }
      router.push(`/compras/productos?eliminado=${encodeURIComponent(f.sku)}`);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setGuardando(false); }
  };

  const campo = (k: keyof Datos, etiqueta: string, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="text-sm">{etiqueta}
      <input className="campo" value={f[k] as string} onChange={(e) => set(k, e.target.value as never)} {...extra} />
    </label>
  );

  return (
    <div className="p-3 sm:p-5 max-w-5xl flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">{esNuevo ? "Nuevo producto" : `Editar producto ${f.sku}`}</h1>
        <Link href="/compras/productos" className="underline text-sm">← Volver a productos</Link>
      </div>
      {msg && <div role="alert" className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <span className="font-semibold">Tipo:</span>
          <label><input type="radio" disabled={!esNuevo} checked={f.presentacion === "piso"} onChange={() => set("presentacion", "piso")} /> Piso / azulejo (por caja y pieza, precio por m²)</label>
          <label><input type="radio" disabled={!esNuevo} checked={f.presentacion === "unidad"} onChange={() => set("presentacion", "unidad")} /> Otro producto (adhesivo, valvulería, etc.)</label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm lg:col-span-2">Descripción
            <input className="campo" value={f.nombre} onChange={(e) => set("nombre", e.target.value)} placeholder="Ej. Piso Madera Gris (vacío = marca + formato + SKU)" />
          </label>
          <label className="text-sm">Marca
            <input className="campo" list="lista-marcas" value={f.marca} onChange={(e) => set("marca", e.target.value)} placeholder="Ej. Daltile" />
            <datalist id="lista-marcas">{marcas.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label className="text-sm">Categoría
            <input className="campo" list="lista-categorias" value={f.categoria} onChange={(e) => set("categoria", e.target.value)} placeholder="Ej. Pisos" />
            <datalist id="lista-categorias">{categorias.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          {campo("formato", "Formato", { placeholder: "Ej. 60x60" })}
          <label className="text-sm">SKU
            <input className="campo" value={f.sku} onChange={(e) => set("sku", e.target.value.toUpperCase())}
              placeholder={esNuevo ? `Automático: ${prefijoSku(f.marca, f.categoria, f.formato)}` : ""} />
          </label>
          {campo("codigo_barras", "Código de barras")}
          {f.presentacion === "unidad" && (
            <label className="text-sm">Unidad de venta
              <select className="campo" value={f.unidad} disabled={!esNuevo} onChange={(e) => set("unidad", e.target.value)}>
                {UNIDADES.map((u) => <option key={u} value={u}>{u}</option>)}
                {!UNIDADES.includes(f.unidad as never) && <option value={f.unidad}>{f.unidad}</option>}
              </select>
            </label>
          )}
        </div>

        {f.presentacion === "piso" ? (
          <>
            <div className="barra-seccion">Caja y precio</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {campo("piezas_por_caja", "Piezas por caja *", { inputMode: "numeric" })}
              {campo("m2_por_caja", "m² por caja *", { inputMode: "decimal" })}
              {campo("precio_m2", "Precio por m² (sin IVA)", { inputMode: "decimal" })}
              <div className="text-sm">
                <div>Precios de venta</div>
                {calc && !manualCaja ? (
                  <div className="mt-1">
                    Caja: <b>{mxnPrecio(calc.caja)}</b> · Pieza: <b>{mxnPrecio(calc.pieza)}</b>
                    <div className="text-xs text-[var(--tenue)]">Área por pieza: {calc.m2PorPieza.toDecimalPlaces(4).toString()} m² (m² por caja ÷ piezas)</div>
                  </div>
                ) : !manualCaja && <div className="mt-1 text-[var(--tenue)]">Se calculan al llenar caja y precio por m².</div>}
                <label className="text-xs block mt-1"><input type="checkbox" checked={manualCaja} onChange={(e) => setManualCaja(e.target.checked)} /> Escribir precio de caja y pieza a mano</label>
              </div>
              {manualCaja && <>{campo("precio_caja", "Precio por caja", { inputMode: "decimal" })}{campo("precio_pieza", "Precio por pieza (vacío = caja ÷ piezas)", { inputMode: "decimal" })}</>}
            </div>
            {(() => {
              // Aviso si el área por pieza no cuadra con el formato (p. ej. 60x60 = 0.36 m²): suele ser un error de captura
              const nominal = areaFormato(f.formato);
              if (!calc || !nominal || nominal.isZero()) return null;
              const dif = calc.m2PorPieza.minus(nominal).abs().div(nominal);
              return dif.gt(0.1) ? (
                <p className="text-xs text-amber-800 bg-amber-50 rounded px-2 py-1">
                  Revisa: con {f.m2_por_caja} m² y {f.piezas_por_caja} piezas, cada pieza mide {calc.m2PorPieza.toDecimalPlaces(4).toString()} m²,
                  pero el formato {f.formato} da {nominal.toDecimalPlaces(4).toString()} m² ({nominal.times(f.piezas_por_caja || 0).toDecimalPlaces(4).toString()} m² por caja).
                </p>
              ) : null;
            })()}
            <p className="text-xs text-[var(--tenue)]">La existencia se lleva en piezas: se vende por caja o por pieza y el sistema descuenta las piezas que correspondan.</p>
          </>
        ) : (
          <>
            <div className="barra-seccion">Precio</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {campo("precio", `Precio por ${f.unidad} (sin IVA)`, { inputMode: "decimal" })}
            </div>
          </>
        )}

        <label className="text-sm">Comentarios
          <textarea className="campo h-16" value={f.comentarios} onChange={(e) => set("comentarios", e.target.value)} />
        </label>
        {!esNuevo && <label className="text-sm"><input type="checkbox" checked={f.activo} onChange={(e) => set("activo", e.target.checked)} /> Activo (desmarca para que ya no aparezca al vender)</label>}

        {esNuevo && (
          <>
            <div className="barra-seccion">Existencia inicial (opcional)</div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-sm">Almacén
                <select className="campo" value={ex.almacen} onChange={(e) => setEx({ ...ex, almacen: e.target.value })}>
                  <option value="">—</option>
                  {almacenes.map((a) => <option key={a.id} value={a.id}>{a.suc ? `${a.suc} · ` : ""}{a.nombre}</option>)}
                </select>
              </label>
              {f.presentacion === "piso" ? (
                <>
                  <label className="text-sm">Cajas<input className="campo" inputMode="numeric" value={ex.cajas} onChange={(e) => setEx({ ...ex, cajas: e.target.value })} /></label>
                  <label className="text-sm">Piezas sueltas<input className="campo" inputMode="numeric" value={ex.sueltas} onChange={(e) => setEx({ ...ex, sueltas: e.target.value })} /></label>
                </>
              ) : (
                <label className="text-sm">Cantidad ({f.unidad})<input className="campo" inputMode="decimal" value={ex.cantidad} onChange={(e) => setEx({ ...ex, cantidad: e.target.value })} /></label>
              )}
            </div>
          </>
        )}

        {intento && errores.length > 0 && <ul className="text-sm text-[var(--peligro)]">{errores.map((e) => <li key={e}>{e}</li>)}</ul>}
        <div className="flex justify-between gap-3 flex-wrap items-center">
          <div>
            {!esNuevo && <button className="text-[var(--peligro)] underline" disabled={guardando} onClick={eliminar}>Eliminar producto</button>}
          </div>
          <div className="flex gap-3 flex-wrap items-center">
            {esNuevo && <button className="underline" disabled={guardando} onClick={() => guardar(true)}>Guardar y capturar otro</button>}
            <button className="btn-primario" disabled={guardando} onClick={() => guardar(false)}>{guardando ? "Guardando…" : "Guardar"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
