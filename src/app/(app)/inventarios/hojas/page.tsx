"use client";
/**
 * Inventarios › Hojas de cálculo: por almacén se elige si el inventario lo lleva el sistema o una hoja
 * de cálculo de Google. Con "hoja", el sistema la lee y deja sus existencias iguales (cada diferencia
 * queda en el kardex como ajuste). La existencia total es la suma de todos los almacenes.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fechaMx } from "@/lib/documentoVenta";
import { fmtCantidad } from "@/lib/unidades";
import { sincronizarAlmacen, type ResultadoHoja } from "@/lib/hojaInventario";

interface Almacen {
  id: string; nombre: string; sucursal: string; fuente_inventario: "sistema" | "hoja"; hoja_url: string | null;
  hoja_sincronizada_en: string | null; hoja_resultado: ResultadoHoja | null;
}

export default function HojasInventario() {
  const [alms, setAlms] = useState<Almacen[]>([]);
  const [edicion, setEdicion] = useState<Record<string, { fuente: "sistema" | "hoja"; url: string }>>({});
  const [admin, setAdmin] = useState(false);
  const [trabajando, setTrabajando] = useState<string | null>(null);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  const cargar = useCallback(async () => {
    const sb = supabase();
    const [a, perm] = await Promise.all([
      sb.from("almacenes").select("id, nombre, fuente_inventario, hoja_url, hoja_sincronizada_en, hoja_resultado, sucursales!almacenes_sucursal_id_fkey(codigo)")
        .eq("activo", true).order("nombre"),
      sb.rpc("tiene_permiso", { p_permiso: "administrar" }),
    ]);
    setAdmin(perm.data === true);
    if (a.error) {
      setMsg({ tipo: "error", texto: /fuente_inventario|hoja_/.test(a.error.message) ? "Falta ejecutar la migración 20261120000048_inventario_hoja.sql en Supabase." : mensajeError(a.error) });
      return;
    }
    const lista = ((a.data ?? []) as unknown as (Omit<Almacen, "sucursal"> & { sucursales: { codigo: string } | null })[])
      .map(({ sucursales, ...x }) => ({ ...x, sucursal: sucursales?.codigo ?? "" }));
    setAlms(lista);
    setEdicion(Object.fromEntries(lista.map((x) => [x.id, { fuente: x.fuente_inventario, url: x.hoja_url ?? "" }])));
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  const guardar = async (a: Almacen) => {
    const e = edicion[a.id];
    setTrabajando(a.id); setMsg(null);
    try {
      const { error } = await supabase().rpc("configurar_hoja_almacen", { p: { almacen_id: a.id, fuente: e.fuente, hoja_url: e.url.trim() || null } });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `${a.nombre}: ${e.fuente === "hoja" ? "ahora usa la hoja de cálculo. Sincroniza para traer sus existencias." : "ahora el sistema lleva el inventario."}` });
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); } finally { setTrabajando(null); }
  };

  const sincronizar = async (a: Almacen) => {
    if (!a.hoja_url) return;
    setTrabajando(a.id); setMsg(null);
    try {
      const r = await sincronizarAlmacen(a.id, a.hoja_url);
      setMsg({ tipo: "ok", texto: `${a.nombre}: ${r.cambios} producto${r.cambios === 1 ? "" : "s"} actualizado${r.cambios === 1 ? "" : "s"}, ${r.iguales} sin cambio${r.desconocidos.length ? `, ${r.desconocidos.length} SKU de la hoja no existen en el sistema` : ""}.` });
      setAbierto(a.id);
      await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: `${a.nombre}: ${mensajeError(err)}` }); } finally { setTrabajando(null); }
  };

  const sincronizarTodas = async () => {
    for (const a of alms.filter((x) => x.fuente_inventario === "hoja" && x.hoja_url)) await sincronizar(a);
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Inventario desde hojas de cálculo</h1>
        <div className="flex gap-2 items-center">
          <Link href="/inventarios/existencias" className="underline text-sm">Ver existencias (total de todos los almacenes)</Link>
          <button className="btn-primario" disabled={!!trabajando || !alms.some((x) => x.fuente_inventario === "hoja")} onClick={sincronizarTodas}>Sincronizar todas</button>
        </div>
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 text-sm flex flex-col gap-1 text-[var(--tenue)]">
        <span><b className="text-[var(--texto)]">Cómo funciona:</b> en un almacén con fuente «Hoja de cálculo», la hoja manda: al sincronizar, el sistema deja sus existencias iguales a la hoja
          (las ventas descuentan mientras tanto, y en la siguiente lectura se iguala). Cada diferencia queda en el kardex como ajuste.</span>
        <span>Se leen todas las pestañas: columna <b>SKU</b> y <b>CAJAS EN EXISTENCIA</b> + <b>PIEZAS SUELTAS</b> (pisos), o <b>CANTIDAD</b> (otros productos).</span>
        <span>Para que el sistema pueda leerla: en la hoja, <b>Compartir › Acceso general › «Cualquier persona con el enlace» › Lector</b>, y pega aquí su enlace.</span>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[900px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Almacén</th><th className="font-normal w-44">Fuente del inventario</th><th className="font-normal">Enlace de la hoja</th>
            <th className="font-normal">Última sincronización</th><th className="w-56" /></tr></thead>
          <tbody>
            {alms.map((a) => {
              const e = edicion[a.id] ?? { fuente: a.fuente_inventario, url: a.hoja_url ?? "" };
              const cambiado = e.fuente !== a.fuente_inventario || e.url.trim() !== (a.hoja_url ?? "");
              const r = a.hoja_resultado;
              return (
                <Fragment key={a.id}>
                  <tr className="border-b border-[var(--borde)] align-top">
                    <td className="p-2">{a.sucursal ? `${a.sucursal} · ` : ""}{a.nombre}</td>
                    <td className="py-1.5 pr-2">
                      <select className="campo" disabled={!admin} value={e.fuente} onChange={(ev) => setEdicion((x) => ({ ...x, [a.id]: { ...e, fuente: ev.target.value as "sistema" | "hoja" } }))}>
                        <option value="sistema">Sistema</option><option value="hoja">Hoja de cálculo</option>
                      </select>
                    </td>
                    <td className="py-1.5 pr-2">
                      {e.fuente === "hoja"
                        ? <input className="campo" disabled={!admin} placeholder="https://docs.google.com/spreadsheets/d/…" value={e.url} onChange={(ev) => setEdicion((x) => ({ ...x, [a.id]: { ...e, url: ev.target.value } }))} />
                        : <span className="text-[var(--tenue)]">—</span>}
                    </td>
                    <td className="py-2 pr-2">
                      {a.fuente_inventario === "hoja" ? (a.hoja_sincronizada_en ? <>
                        {fechaMx(a.hoja_sincronizada_en)}
                        {r && <button className="block text-xs underline text-[var(--tenue)]" onClick={() => setAbierto(abierto === a.id ? null : a.id)}>
                          {r.cambios} cambio{r.cambios === 1 ? "" : "s"} · {r.iguales} igual{r.iguales === 1 ? "" : "es"}{r.desconocidos.length ? ` · ${r.desconocidos.length} SKU desconocidos` : ""}{r.avisos?.length ? ` · ${r.avisos.length} aviso${r.avisos.length === 1 ? "" : "s"}` : ""}</button>}
                      </> : <span className="text-[var(--tenue)]">Nunca</span>) : <span className="text-[var(--tenue)]">—</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                      {admin && cambiado && <button className="btn-primario mr-2" disabled={trabajando === a.id} onClick={() => guardar(a)}>Guardar</button>}
                      {a.fuente_inventario === "hoja" && a.hoja_url && !cambiado && (
                        <button className="px-3 py-1.5 rounded border border-[var(--acento)] text-[var(--acento)]" disabled={!!trabajando} onClick={() => sincronizar(a)}>
                          {trabajando === a.id ? "Leyendo la hoja…" : "Sincronizar ahora"}</button>
                      )}
                    </td>
                  </tr>
                  {abierto === a.id && r && (
                    <tr><td colSpan={5} className="p-3 bg-[#fafcfb] text-xs">
                      <div className="grid gap-3 lg:grid-cols-3">
                        <div><b>Cambios de la última lectura</b>
                          {r.detalle.length ? <ul className="mt-1">{r.detalle.map((d) => <li key={d.sku}>{d.sku} · {d.nombre}: {fmtCantidad(d.antes, 2)} → {fmtCantidad(d.hoja, 2)}</li>)}</ul> : <div>Ninguno.</div>}</div>
                        <div><b>SKU de la hoja que no existen en el sistema</b> (no se cargaron)
                          {r.desconocidos.length ? <div className="mt-1 break-words">{r.desconocidos.join(", ")}</div> : <div>Ninguno.</div>}</div>
                        <div><b>Otros</b>
                          <div className="mt-1">{r.filas} filas leídas · {r.sin_hoja} producto{r.sin_hoja === 1 ? "" : "s"} con existencia en este almacén no aparecen en la hoja (no se tocaron).</div>
                          {r.avisos?.map((x, i) => <div key={i}>{x}</div>)}</div>
                      </div>
                    </td></tr>
                  )}
                </Fragment>
              );
            })}
            {!alms.length && <tr><td colSpan={5} className="p-6 text-center text-[var(--tenue)]">No hay almacenes activos.</td></tr>}
          </tbody>
        </table>
      </section>
      {!admin && <div className="text-sm text-[var(--tenue)]">Solo un administrador puede cambiar la fuente o el enlace; cualquier usuario del almacén puede sincronizar.</div>}
    </div>
  );
}
