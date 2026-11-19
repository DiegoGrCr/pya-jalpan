"use client";
/**
 * Finanzas › Corte de caja (por sucursal, normalmente semanal).
 * Corte en curso desde el último corte: entradas por forma de pago, devoluciones, retiros de efectivo y gastos.
 * Dos totales: total general (todas las formas) y efectivo esperado en caja. Se cierra con el efectivo contado.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { CATEGORIAS_GASTO, FORMAS_GASTO } from "@/lib/gastos";

interface Linea { concepto: string; forma: string; importe: number }
interface Retiro { id: string; fecha: string; importe: number; concepto: string; usuario: string | null }
interface Gasto extends Retiro { categoria: string; forma: string; proveedor: string | null }
interface Resumen {
  desde: string; hasta: string; entradas: Linea[]; salidas: Linea[]; retiros: Retiro[]; retirado: number;
  gastos?: Gasto[]; gastado?: number; gastado_efectivo?: number; neto?: number;
  total_general: number; efectivo_esperado: number; por_forma: Record<string, number>;
}
interface Corte {
  id: string; serie: string; folio: number; desde: string; hasta: string; total_general: string; efectivo_esperado: string;
  efectivo_contado: string; diferencia: string; notas: string | null; usuario_id: string | null; resumen: Resumen;
}
const FORMAS = ["efectivo", "tarjeta_debito", "tarjeta_credito", "transferencia"];
const $ = (n: number | string) => `$${fmtImporte(Number(n))}`;

/** Tabla concepto × forma de pago */
function TablaFormas({ titulo, lineas, signo }: { titulo: string; lineas: Linea[]; signo: "+" | "−" }) {
  const conceptos = [...new Set(lineas.map((l) => l.concepto))];
  const val = (c: string, f: string) => lineas.filter((l) => l.concepto === c && l.forma === f).reduce((s, l) => s + Number(l.importe), 0);
  if (!conceptos.length) return <div className="text-sm text-[var(--tenue)]">{titulo}: sin movimientos.</div>;
  return (
    <table className="w-full text-sm">
      <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
        <th className="py-1 font-normal">{titulo}</th>{FORMAS.map((f) => <th key={f} className="font-normal text-right pr-2">{FORMAS_PAGO[f]}</th>)}<th className="font-normal text-right">Total</th></tr></thead>
      <tbody>
        {conceptos.map((c) => (
          <tr key={c} className="border-b border-[var(--borde)]">
            <td className="py-1.5 pr-2">({signo}) {c}</td>
            {FORMAS.map((f) => <td key={f} className="text-right pr-2">{val(c, f) ? $(val(c, f)) : "—"}</td>)}
            <td className="text-right font-medium">{$(FORMAS.reduce((s, f) => s + val(c, f), 0))}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function CorteCaja() {
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [sucursal, setSucursal] = useState("");
  const [r, setR] = useState<Resumen | null>(null);
  const [cortes, setCortes] = useState<Corte[]>([]);
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [contado, setContado] = useState("");
  const [notas, setNotas] = useState("");
  const [retiro, setRetiro] = useState<{ clave: string; tipo: "retiro" | "gasto"; importe: string; concepto: string;
    categoria: string; forma: string; proveedor: string; fecha: string } | null>(null);
  const nuevoMov = (tipo: "retiro" | "gasto") => setRetiro({ clave: crypto.randomUUID(), tipo, importe: "", concepto: "", categoria: "", forma: "efectivo", proveedor: "",
    fecha: new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) });
  const [abierto, setAbierto] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [clave, setClave] = useState(() => crypto.randomUUID());

  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      const { data } = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre)").eq("user_id", user?.id ?? "");
      let suc = ((data ?? []) as unknown as { sucursales: { id: string; codigo: string; nombre: string } | null }[]).map((x) => x.sucursales).filter((x): x is { id: string; codigo: string; nombre: string } => !!x);
      if (!suc.length) suc = ((await sb.from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")).data ?? []) as { id: string; codigo: string; nombre: string }[];
      setSucursales(suc);
      setSucursal(suc[0]?.id ?? "");
    })();
  }, []);

  const cargar = useCallback(async () => {
    if (!sucursal) return;
    setMsg(null);
    try {
      const sb = supabase();
      const [res, hist] = await Promise.all([
        sb.rpc("corte_resumen", { p: { sucursal_id: sucursal } }),
        sb.from("cortes_caja").select("id, serie, folio, desde, hasta, total_general, efectivo_esperado, efectivo_contado, diferencia, notas, usuario_id, resumen")
          .eq("sucursal_id", sucursal).order("hasta", { ascending: false }).limit(60),
      ]);
      if (res.error) {
        if (/corte_resumen/.test(res.error.message)) throw new Error("Falta ejecutar la migración 20261119000039_corte_caja.sql en Supabase.");
        throw res.error;
      }
      setR(res.data as Resumen);
      const h = (hist.data ?? []) as Corte[];
      setCortes(h);
      const ids = h.map((x) => x.usuario_id ?? "").filter(Boolean);
      if (ids.length) setNombres(await nombresUsuarios(ids));
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); }
  }, [sucursal]);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (msg?.tipo !== "ok") return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);

  const diferencia = useMemo(() => (r && contado !== "" ? Number(contado) - Number(r.efectivo_esperado) : null), [r, contado]);

  const guardarRetiro = async () => {
    if (!retiro) return;
    setTrabajando(true);
    try {
      const hoyMx = new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
      const base = { idempotency_key: retiro.clave, sucursal_id: sucursal, importe: retiro.importe, concepto: retiro.concepto };
      const p = retiro.tipo === "retiro" ? base : {
        ...base, tipo: "gasto", categoria: retiro.categoria, forma: retiro.forma, proveedor: retiro.proveedor || null,
        // fecha anterior: a mediodía de ese día; hoy: la hora actual
        fecha: retiro.fecha && retiro.fecha !== hoyMx ? `${retiro.fecha}T12:00:00-06:00` : null,
      };
      // sin la migración 0040 el gasto se guardaría como retiro: comprobar antes
      if (retiro.tipo === "gasto") {
        const { error: e2 } = await supabase().from("retiros_caja").select("tipo").limit(1);
        if (e2) throw new Error("Falta ejecutar la migración 20261119000040_gastos.sql en Supabase.");
      }
      const { error } = await supabase().rpc("registrar_retiro", { p });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: retiro.tipo === "gasto" ? "Gasto registrado." : "Retiro registrado." }); setRetiro(null); await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };
  const cancelarRetiro = async (x: Retiro) => {
    if (!window.confirm(`¿Cancelar ${"categoria" in x ? "el gasto" : "el retiro"} de ${$(x.importe)} (${x.concepto})?`)) return;
    const { error } = await supabase().rpc("cancelar_retiro", { p_id: x.id });
    if (error) { setMsg({ tipo: "error", texto: mensajeError(error) }); return; }
    await cargar();
  };
  const cerrar = async () => {
    if (!r || contado === "") return;
    if (!window.confirm(`¿Cerrar el corte?\n\nTotal general: ${$(r.total_general)}\nEfectivo esperado: ${$(r.efectivo_esperado)}\nEfectivo contado: ${$(contado)}\nDiferencia: ${$(diferencia ?? 0)}`)) return;
    setTrabajando(true);
    try {
      const { data, error } = await supabase().rpc("cerrar_corte", { p: { idempotency_key: clave, sucursal_id: sucursal, efectivo_contado: contado, notas: notas || null } });
      if (error) throw error;
      setContado(""); setNotas(""); setClave(crypto.randomUUID());
      setMsg({ tipo: "ok", texto: `Corte ${data.serie} ${data.folio} cerrado.` });
      await cargar();
      setAbierto(data.corte_id);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  /** Imprime un corte (hoja sencilla) */
  const imprimir = (c: Corte) => {
    const suc = sucursales.find((x) => x.id === sucursal);
    const fila = (l: Linea) => `<tr><td>${l.concepto}</td><td>${FORMAS_PAGO[l.forma] ?? l.forma}</td><td style="text-align:right">${$(l.importe)}</td></tr>`;
    const w = window.open("", "_blank", "width=800,height=900");
    if (!w) return;
    w.document.write(`<html><head><title>Corte ${c.serie} ${c.folio}</title><style>body{font-family:Arial;font-size:12px;margin:24px}table{width:100%;border-collapse:collapse;margin:6px 0 14px}td,th{border-bottom:1px solid #ddd;padding:4px;text-align:left}h1{font-size:18px}.t{font-size:14px;font-weight:bold}</style></head><body>
      <h1>Corte de caja ${c.serie} ${c.folio}</h1><div>${suc ? `${suc.codigo} - ${suc.nombre}` : ""}</div>
      <div>Del ${fechaMx(c.desde)} al ${fechaMx(c.hasta)} · Realizó: ${c.usuario_id ? nombres[c.usuario_id] ?? "" : ""}</div>
      <h3>Entradas</h3><table>${c.resumen.entradas.map(fila).join("") || "<tr><td>Sin entradas</td></tr>"}</table>
      <h3>Devoluciones</h3><table>${c.resumen.salidas.map(fila).join("") || "<tr><td>Sin devoluciones</td></tr>"}</table>
      <h3>Retiros de efectivo</h3><table>${c.resumen.retiros.map((x) => `<tr><td>${fechaMx(x.fecha)}</td><td>${x.concepto}</td><td style="text-align:right">${$(x.importe)}</td></tr>`).join("") || "<tr><td>Sin retiros</td></tr>"}</table>
      ${c.resumen.gastos?.length ? `<h3>Gastos</h3><table>${c.resumen.gastos.map((x) => `<tr><td>${fechaMx(x.fecha)}</td><td>${x.categoria}</td><td>${x.concepto}${x.proveedor ? ` · ${x.proveedor}` : ""}</td><td>${FORMAS_PAGO[x.forma] ?? x.forma}</td><td style="text-align:right">${$(x.importe)}</td></tr>`).join("")}</table>` : ""}
      <table>${FORMAS.map((f) => `<tr><td>${FORMAS_PAGO[f]}</td><td style="text-align:right">${$(c.resumen.por_forma?.[f] ?? 0)}</td></tr>`).join("")}
      <tr class="t"><td>TOTAL GENERAL</td><td style="text-align:right">${$(c.total_general)}</td></tr>
      ${c.resumen.gastado ? `<tr><td>Gastos</td><td style="text-align:right">−${$(c.resumen.gastado)}</td></tr><tr class="t"><td>INGRESOS MENOS GASTOS</td><td style="text-align:right">${$(c.resumen.neto ?? 0)}</td></tr>` : ""}
      <tr><td>Retiros</td><td style="text-align:right">−${$(c.resumen.retirado)}</td></tr>
      ${c.resumen.gastado_efectivo ? `<tr><td>Gastos pagados en efectivo</td><td style="text-align:right">−${$(c.resumen.gastado_efectivo)}</td></tr>` : ""}
      <tr class="t"><td>EFECTIVO ESPERADO</td><td style="text-align:right">${$(c.efectivo_esperado)}</td></tr>
      <tr><td>Efectivo contado</td><td style="text-align:right">${$(c.efectivo_contado)}</td></tr>
      <tr class="t"><td>DIFERENCIA</td><td style="text-align:right">${$(c.diferencia)}</td></tr></table>
      ${c.notas ? `<p>Notas: ${c.notas}</p>` : ""}<br><br><br><div style="width:220px;border-top:1px solid #000;text-align:center">Firma</div></body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      {msg && (msg.tipo === "ok"
        ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-md px-4 py-2 text-sm shadow-lg bg-emerald-600 text-white">✓ {msg.texto}</div>
        : <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>)}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Corte de caja</h1>
        <label className="text-sm">Sucursal
          <select className="campo !w-auto" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
            {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
      </div>

      {r && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-4">
          <div className="flex justify-between flex-wrap gap-2 items-baseline">
            <div className="barra-seccion flex-1">Corte en curso</div>
            <span className="text-sm text-[var(--tenue)]">Desde {fechaMx(r.desde)} hasta ahora</span>
          </div>
          <TablaFormas titulo="Entradas" lineas={r.entradas} signo="+" />
          <TablaFormas titulo="Devoluciones de dinero" lineas={r.salidas} signo="−" />

          <div>
            <div className="flex justify-between items-center mb-1">
              <h2 className="font-medium">Retiros de efectivo</h2>
              <button className="btn-primario" onClick={() => nuevoMov("retiro")}>+ Registrar retiro</button>
            </div>
            {r.retiros.length === 0 ? <div className="text-sm text-[var(--tenue)]">Sin retiros en este corte.</div> : (
              <table className="w-full text-sm"><tbody>
                {r.retiros.map((x) => (
                  <tr key={x.id} className="border-b border-[var(--borde)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fechaMx(x.fecha)}</td><td className="pr-3">{x.concepto}</td>
                    <td className="pr-3 text-[var(--tenue)]">{x.usuario ?? ""}</td><td className="pr-3 text-right">{$(x.importe)}</td>
                    <td className="text-right"><button className="underline text-xs text-[var(--peligro)]" onClick={() => cancelarRetiro(x)}>Cancelar</button></td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>

          <div>
            <div className="flex justify-between items-center mb-1">
              <h2 className="font-medium">Gastos</h2>
              <button className="btn-primario" onClick={() => nuevoMov("gasto")}>+ Registrar gasto</button>
            </div>
            {!r.gastos?.length ? <div className="text-sm text-[var(--tenue)]">Sin gastos en este corte.</div> : (
              <table className="w-full text-sm"><tbody>
                {r.gastos.map((x) => (
                  <tr key={x.id} className="border-b border-[var(--borde)]">
                    <td className="py-1.5 pr-3 whitespace-nowrap">{fechaMx(x.fecha)}</td><td className="pr-3 whitespace-nowrap">{x.categoria}</td>
                    <td className="pr-3">{x.concepto}{x.proveedor ? <span className="text-[var(--tenue)]"> · {x.proveedor}</span> : null}</td>
                    <td className="pr-3 whitespace-nowrap">{FORMAS_PAGO[x.forma] ?? x.forma}</td>
                    <td className="pr-3 text-[var(--tenue)]">{x.usuario ?? ""}</td><td className="pr-3 text-right">{$(x.importe)}</td>
                    <td className="text-right"><button className="underline text-xs text-[var(--peligro)]" onClick={() => cancelarRetiro(x)}>Cancelar</button></td>
                  </tr>
                ))}
              </tbody></table>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="text-sm">
              <h2 className="font-medium mb-1">Por forma de pago</h2>
              {FORMAS.map((f) => (
                <div key={f} className="flex justify-between px-2 py-1 odd:bg-[#f4f7f6]"><span>{FORMAS_PAGO[f]}</span><span>{$(r.por_forma?.[f] ?? 0)}</span></div>
              ))}
              <div className="flex justify-between px-2 py-1.5 mt-1 text-white font-semibold rounded" style={{ background: "var(--acento)" }}><span>Total general</span><span>{$(r.total_general)}</span></div>
              {r.gastos !== undefined && (<>
                <div className="flex justify-between px-2 py-1 mt-1"><span>(−) Gastos (todas las formas)</span><span>{$(r.gastado ?? 0)}</span></div>
                <div className="flex justify-between px-2 py-1.5 font-semibold border-t border-[var(--borde)]"><span>Ingresos menos gastos</span><span>{$(r.neto ?? r.total_general)}</span></div>
              </>)}
            </div>
            <div className="text-sm">
              <h2 className="font-medium mb-1">Efectivo</h2>
              <div className="flex justify-between px-2 py-1 bg-[#f4f7f6]"><span>(+) Efectivo recibido (neto de devoluciones)</span><span>{$(Number(r.efectivo_esperado) + Number(r.retirado) + Number(r.gastado_efectivo ?? 0))}</span></div>
              <div className="flex justify-between px-2 py-1"><span>(−) Retiros</span><span>{$(r.retirado)}</span></div>
              {r.gastos !== undefined && <div className="flex justify-between px-2 py-1 bg-[#f4f7f6]"><span>(−) Gastos pagados en efectivo</span><span>{$(r.gastado_efectivo ?? 0)}</span></div>}
              <div className="flex justify-between px-2 py-1.5 mt-1 text-white font-semibold rounded" style={{ background: "var(--acento)" }}><span>Efectivo esperado en caja</span><span>{$(r.efectivo_esperado)}</span></div>
              <div className="grid grid-cols-2 gap-3 mt-3 items-end">
                <label>Efectivo contado<input className="campo text-right" inputMode="decimal" value={contado} onChange={(e) => setContado(e.target.value)} placeholder="0.00" /></label>
                <div className={`text-right ${diferencia === null ? "text-[var(--tenue)]" : diferencia === 0 ? "text-emerald-700" : "text-[var(--peligro)]"} font-semibold`}>
                  {diferencia === null ? "Diferencia: —" : `Diferencia: ${diferencia > 0 ? "sobra " : diferencia < 0 ? "falta " : ""}${$(Math.abs(diferencia))}`}
                </div>
                <label className="col-span-2">Notas<input className="campo" value={notas} onChange={(e) => setNotas(e.target.value)} /></label>
              </div>
              <div className="flex justify-end mt-3">
                <button className="btn-primario" disabled={trabajando || contado === ""} onClick={cerrar}>{trabajando ? "Cerrando…" : "Cerrar corte"}</button>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <div className="px-4 pt-3 font-medium">Cortes anteriores</div>
        <table className="w-full text-sm min-w-[860px]">
          <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
            <th className="p-2 font-normal">Folio</th><th className="pr-3 font-normal">Periodo</th><th className="pr-3 font-normal text-right">Total general</th>
            <th className="pr-3 font-normal text-right">Efectivo esperado</th><th className="pr-3 font-normal text-right">Contado</th><th className="pr-3 font-normal text-right">Diferencia</th>
            <th className="pr-3 font-normal">Realizó</th><th className="pr-2" /></tr></thead>
          <tbody>
            {cortes.map((c) => (
              <Fragment key={c.id}>
                <tr className="border-b border-[var(--borde)] cursor-pointer hover:bg-[var(--resalte)]" onClick={() => setAbierto(abierto === c.id ? null : c.id)}>
                  <td className="p-2 whitespace-nowrap">{abierto === c.id ? "▾" : "▸"} {c.serie} {c.folio}</td>
                  <td className="pr-3 whitespace-nowrap">{fechaMx(c.desde)} – {fechaMx(c.hasta)}</td>
                  <td className="pr-3 text-right">{$(c.total_general)}</td><td className="pr-3 text-right">{$(c.efectivo_esperado)}</td>
                  <td className="pr-3 text-right">{$(c.efectivo_contado)}</td>
                  <td className={`pr-3 text-right font-semibold ${Number(c.diferencia) === 0 ? "text-emerald-700" : "text-[var(--peligro)]"}`}>{$(c.diferencia)}</td>
                  <td className="pr-3">{c.usuario_id ? nombres[c.usuario_id] ?? "" : ""}</td>
                  <td className="pr-2 text-right"><button className="underline" onClick={(e) => { e.stopPropagation(); imprimir(c); }}>Imprimir</button></td>
                </tr>
                {abierto === c.id && (
                  <tr><td colSpan={8} className="p-3 bg-[#fafcfb]">
                    <div className="flex flex-col gap-3">
                      <TablaFormas titulo="Entradas" lineas={c.resumen.entradas} signo="+" />
                      <TablaFormas titulo="Devoluciones de dinero" lineas={c.resumen.salidas} signo="−" />
                      {!!c.resumen.gastos?.length && <div className="text-sm">Gastos: {c.resumen.gastos.map((x) => `${x.categoria} · ${x.concepto} ${$(x.importe)} (${FORMAS_PAGO[x.forma] ?? x.forma})`).join(" · ")}</div>}
                      <div className="text-sm">Retiros: {c.resumen.retiros.length ? c.resumen.retiros.map((x) => `${x.concepto} ${$(x.importe)}`).join(" · ") : "ninguno"}</div>
                      {c.notas && <div className="text-sm">Notas: {c.notas}</div>}
                    </div>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!cortes.length && <tr><td colSpan={8} className="p-6 text-center text-[var(--tenue)]">Aún no hay cortes de esta sucursal.</td></tr>}
          </tbody>
        </table>
      </section>

      {retiro && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setRetiro(null)}>
          <div role="dialog" aria-label={retiro.tipo === "gasto" ? "Registrar gasto" : "Registrar retiro"} className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">{retiro.tipo === "gasto" ? "Registrar gasto" : "Registrar retiro de efectivo"}</h2>
            <p className="text-[var(--tenue)] mt-1">{retiro.tipo === "gasto"
              ? "Algo que se pagó con dinero de la sucursal. Si fue en efectivo, se descuenta del efectivo esperado en caja."
              : "Dinero que sale de la caja sin ser un gasto (depósito al banco, entrega al dueño)."}</p>
            <div className="grid gap-3 mt-3 sm:grid-cols-2">
              <label>Importe<input className="campo" inputMode="decimal" autoFocus value={retiro.importe} onChange={(e) => setRetiro({ ...retiro, importe: e.target.value })} /></label>
              {retiro.tipo === "gasto" && (
                <label>Categoría
                  <select className="campo" value={retiro.categoria} onChange={(e) => setRetiro({ ...retiro, categoria: e.target.value })}>
                    <option value="">Elige…</option>{CATEGORIAS_GASTO.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
              )}
              <label className="sm:col-span-2">Concepto<input className="campo" placeholder={retiro.tipo === "gasto" ? "p. ej. Flete de material, garrafones de agua…" : "p. ej. Depósito al banco"} value={retiro.concepto} onChange={(e) => setRetiro({ ...retiro, concepto: e.target.value })} /></label>
              {retiro.tipo === "gasto" && (<>
                <label>Forma de pago
                  <select className="campo" value={retiro.forma} onChange={(e) => setRetiro({ ...retiro, forma: e.target.value })}>
                    {FORMAS_GASTO.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f]}</option>)}
                  </select>
                </label>
                <label>Fecha<input type="date" className="campo" value={retiro.fecha} max={new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" })} onChange={(e) => setRetiro({ ...retiro, fecha: e.target.value })} /></label>
                <label className="sm:col-span-2">Proveedor / a quién se pagó (opcional)<input className="campo" value={retiro.proveedor} onChange={(e) => setRetiro({ ...retiro, proveedor: e.target.value })} /></label>
              </>)}
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setRetiro(null)}>Cancelar</button>
              <button className="btn-primario" disabled={trabajando || !(Number(retiro.importe) > 0) || !retiro.concepto.trim() || (retiro.tipo === "gasto" && !retiro.categoria)} onClick={guardarRetiro}>{trabajando ? "Guardando…" : "Registrar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
