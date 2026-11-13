"use client";
/**
 * Compras > Productos > Importar: sube la plantilla (o el Excel descargado de la hoja de Google),
 * revisa la vista previa por pestaña y carga todo en una sola operación (todo o nada).
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { HojaImport, generarPlantilla, leerExcel } from "@/lib/productos";

type UsoPestana = "marca" | "categoria" | "nada";
interface Config { incluir: boolean; uso: UsoPestana }

const LOTE = 400; // filas por llamada para no exceder el tamaño de la petición

export default function ImportarProductos() {
  const [hojas, setHojas] = useState<HojaImport[]>([]);
  const [config, setConfig] = useState<Record<string, Config>>({});
  const [almacenes, setAlmacenes] = useState<{ id: string; nombre: string; suc: string }[]>([]);
  const [almacen, setAlmacen] = useState("");
  const [archivo, setArchivo] = useState("");
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [progreso, setProgreso] = useState("");
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [verHoja, setVerHoja] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase().from("almacenes").select("id, nombre, sucursales(codigo)").eq("activo", true).order("nombre");
      const al = ((data ?? []) as unknown as { id: string; nombre: string; sucursales: { codigo: string } | null }[])
        .map((x) => ({ id: x.id, nombre: x.nombre, suc: x.sucursales?.codigo ?? "" }));
      setAlmacenes(al);
      if (al.length === 1) setAlmacen(al[0].id);
    })();
  }, []);

  const abrir = async (f: File | undefined) => {
    if (!f) return;
    setLeyendo(true); setMsg(null); setHojas([]);
    try {
      const h = await leerExcel(f);
      if (!h.length) throw new Error("No encontré ninguna pestaña con la columna DESCRIPCIÓN. Usa la plantilla o revisa los encabezados.");
      setHojas(h);
      setArchivo(f.name);
      setConfig(Object.fromEntries(h.map((x) => [x.nombre, { incluir: x.filas.length > 0, uso: x.tieneMarca ? (x.tieneCategoria ? "nada" : "categoria") : "marca" } as Config])));
      setVerHoja(h[0].nombre);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setLeyendo(false); }
  };

  /** Filas finales: la pestaña rellena marca o categoría cuando la fila no la trae. */
  const filas = useMemo(() => hojas.flatMap((h) => {
    const c = config[h.nombre];
    if (!c?.incluir) return [];
    return h.filas.map((f) => {
      const d = { ...f.datos, fila: `${h.nombre} ${f.fila}` } as Record<string, unknown>;
      if (c.uso === "marca" && !d.marca) d.marca = h.nombre;
      if (c.uso === "categoria" && !d.categoria) d.categoria = h.nombre;
      return { ...f, hoja: h.nombre, datos: d };
    });
  }), [hojas, config]);
  const validas = filas.filter((f) => !f.errores.length);
  const conError = filas.filter((f) => f.errores.length);
  const conExistencia = validas.some((f) => ["cajas", "piezas_sueltas", "cantidad"].some((k) => Number(f.datos[k]) > 0));

  const importar = async () => {
    if (!validas.length) return;
    if (conExistencia && !almacen) { setMsg({ tipo: "error", texto: "Elige el almacén donde se cargará la existencia." }); return; }
    if (conError.length && !window.confirm(`${conError.length} fila(s) tienen errores y NO se importarán. ¿Continuar con las ${validas.length} correctas?`)) return;
    setImportando(true); setMsg(null);
    let creados = 0, actualizados = 0;
    try {
      for (let i = 0; i < validas.length; i += LOTE) {
        setProgreso(`Importando ${Math.min(i + LOTE, validas.length)} de ${validas.length}…`);
        const { data, error } = await supabase().rpc("importar_productos", { p: {
          idempotency_key: crypto.randomUUID(), almacen_id: almacen || null, filas: validas.slice(i, i + LOTE).map((f) => f.datos),
        } });
        if (error) throw new Error(`${error.message}${i > 0 ? ` (las primeras ${i} filas ya se importaron; corrige y vuelve a subir el archivo: no se duplican)` : ""}`);
        creados += data.creados ?? 0; actualizados += data.actualizados ?? 0;
      }
      setMsg({ tipo: "ok", texto: `Listo: ${creados} producto(s) nuevo(s) y ${actualizados} actualizado(s).${conError.length ? ` ${conError.length} fila(s) con error no se importaron.` : ""}` });
      setHojas([]); setArchivo("");
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
    finally { setImportando(false); setProgreso(""); }
  };

  const descargarPlantilla = async () => {
    const b = await generarPlantilla();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b); a.download = "plantilla-productos.xlsx"; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const hoja = hojas.find((h) => h.nombre === verHoja);
  const filasHoja = filas.filter((f) => f.hoja === verHoja);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4 max-w-6xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Importar productos desde Excel</h1>
        <Link href="/compras/productos" className="underline text-sm">← Volver a productos</Link>
      </div>
      {msg && <div role="alert" className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-3 text-sm">
        <ol className="list-decimal pl-5 flex flex-col gap-1">
          <li><button className="underline" onClick={descargarPlantilla}>Descarga la plantilla</button> y llénala, <b>o</b> descarga tu hoja de Google en <i>Archivo › Descargar › Microsoft Excel (.xlsx)</i>.</li>
          <li>Súbela aquí. Se leen todas las pestañas con los mismos encabezados (DESCRIPCIÓN, PIEZAS X CAJA, M² X CAJA, CAJAS EN EXISTENCIA, PRECIO…).</li>
          <li>Revisa la vista previa y presiona <b>Importar</b>. La existencia solo se carga para productos nuevos.</li>
        </ol>
        <div className="flex flex-wrap gap-4 items-end">
          <label>Archivo (.xlsx)
            <input type="file" accept=".xlsx" className="block mt-1" disabled={leyendo || importando} onChange={(e) => { abrir(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <label className="min-w-64">Almacén para la existencia inicial
            <select className="campo" value={almacen} onChange={(e) => setAlmacen(e.target.value)}>
              <option value="">—</option>
              {almacenes.map((a) => <option key={a.id} value={a.id}>{a.suc ? `${a.suc} · ` : ""}{a.nombre}</option>)}
            </select>
          </label>
        </div>
        {leyendo && <div>Leyendo archivo…</div>}
      </section>

      {hojas.length > 0 && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-3 text-sm">
          <div className="barra-seccion">Pestañas de {archivo}</div>
          <table className="w-full">
            <thead className="text-left" style={{ color: "var(--acento)" }}>
              <tr><th className="font-normal py-1">Importar</th><th className="font-normal">Pestaña</th><th className="font-normal">Filas</th><th className="font-normal">El nombre de la pestaña es…</th><th></th></tr>
            </thead>
            <tbody>
              {hojas.map((h) => {
                const c = config[h.nombre];
                const err = h.filas.filter((f) => f.errores.length).length;
                return (
                  <tr key={h.nombre} className="border-t border-[var(--borde)]">
                    <td className="py-1"><input type="checkbox" checked={c?.incluir ?? false} onChange={(e) => setConfig({ ...config, [h.nombre]: { ...c, incluir: e.target.checked } })} /></td>
                    <td>{h.nombre}</td>
                    <td>{h.filas.length}{err ? <span className="text-[var(--peligro)]"> ({err} con error)</span> : ""}</td>
                    <td>
                      <select className="campo !py-1" value={c?.uso} onChange={(e) => setConfig({ ...config, [h.nombre]: { ...c, uso: e.target.value as UsoPestana } })}>
                        <option value="marca">Marca (si la fila no trae marca)</option>
                        <option value="categoria">Categoría (si la fila no trae categoría)</option>
                        <option value="nada">No usarlo</option>
                      </select>
                    </td>
                    <td><button className="underline" onClick={() => setVerHoja(h.nombre)}>{verHoja === h.nombre ? "Viendo" : "Ver filas"}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {hoja && (
            <div className="overflow-x-auto max-h-[420px] overflow-y-auto border border-[var(--borde)] rounded">
              <table className="w-full min-w-[900px]">
                <thead className="sticky top-0 bg-[var(--panel)] text-left" style={{ color: "var(--acento)" }}>
                  <tr><th className="font-normal p-1">Fila</th><th className="font-normal">Descripción</th><th className="font-normal">Marca</th><th className="font-normal">Categoría</th>
                    <th className="font-normal">Formato</th><th className="font-normal">Tipo</th><th className="font-normal">Precio</th><th className="font-normal">Existencia</th><th className="font-normal">Observaciones</th></tr>
                </thead>
                <tbody>
                  {(config[hoja.nombre]?.incluir ? filasHoja : hoja.filas.map((f) => ({ ...f, hoja: hoja.nombre }))).map((f) => {
                    const d = f.datos as Record<string, string | null>;
                    const piso = d.presentacion === "piso";
                    return (
                      <tr key={f.fila} className="border-t border-[var(--borde)]" style={f.errores.length ? { background: "#fdecec" } : f.avisos.length ? { background: "#fff7e0" } : undefined}>
                        <td className="p-1">{f.fila}</td>
                        <td>{d.nombre}{d.sku ? <span className="text-xs text-[var(--tenue)]"> · {d.sku}</span> : ""}</td>
                        <td>{d.marca ?? "—"}</td><td>{d.categoria ?? "—"}</td><td>{d.formato ?? "—"}</td>
                        <td>{piso ? `Piso ${d.piezas_por_caja} pz / ${d.m2_por_caja} m²` : d.unidad}</td>
                        <td>{piso ? (d.precio_m2 ? `$${d.precio_m2}/m²` : "—") : (d.precio ? `$${d.precio}` : "—")}</td>
                        <td>{piso ? `${d.cajas ?? 0} cj${Number(d.piezas_sueltas) ? ` + ${d.piezas_sueltas} pz` : ""}` : (d.cantidad ?? "0")}</td>
                        <td className="text-xs">{[...f.errores.map((e) => `✕ ${e}`), ...f.avisos.map((a) => `⚠ ${a}`)].join(" · ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-between items-center flex-wrap gap-3">
            <span>{validas.length} fila(s) listas{conError.length ? `, ${conError.length} con error (se omiten)` : ""}.</span>
            <button className="btn-primario" disabled={importando || !validas.length} onClick={importar}>{importando ? progreso || "Importando…" : `Importar ${validas.length} producto(s)`}</button>
          </div>
        </section>
      )}
    </div>
  );
}
