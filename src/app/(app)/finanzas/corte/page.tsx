"use client";
/**
 * Finanzas › Corte de caja (por sucursal, normalmente semanal).
 * Corte en curso (por omisión desde el último corte hasta hoy; las fechas se pueden elegir): ventas (folio, cliente, cómo se pagó, estatus), entradas por forma de pago,
 * devoluciones, retiros y gastos; cuadre de efectivo como lo pide la contadora. Se cierra con el efectivo contado.
 * Se imprime o se exporta a Excel (en curso y cortes anteriores).
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { FORMAS_PAGO, cargarEmpresa, fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { $, AVISO_SIN_VENTAS, FORMAS, cuadreEfectivo, estatusCorte, excelCorte, imprimirCorte, pagoDe, totalesVentas,
  type DatosCorte, type Linea, type Resumen, type Retiro, type VentaCorte } from "@/lib/corteCaja";
import { CATEGORIAS_GASTO, FORMAS_GASTO } from "@/lib/gastos";
import { EsqueletoTabla } from "@/components/Esqueleto";

interface Corte {
  id: string; serie: string; folio: number; desde: string; hasta: string; total_general: string; efectivo_esperado: string;
  efectivo_contado: string; diferencia: string; notas: string | null; usuario_id: string | null; resumen: Resumen;
}

/** Ventas del corte: folio, cliente, cuánto se cobró por forma y estatus */
function VentasCorte({ ventas }: { ventas: VentaCorte[] }) {
  if (!ventas.length) return <div className="text-sm text-[var(--tenue)]">Sin ventas en este corte.</div>;
  const t = totalesVentas(ventas);
  const m = (x: number) => (x ? $(x) : "");
  const color: Record<string, string> = { Pagada: "bg-emerald-100 text-emerald-900", "Por cobrar": "bg-amber-100 text-amber-900",
    Cancelada: "bg-gray-200 text-gray-700", "Abono a venta anterior": "bg-sky-100 text-sky-900" };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm min-w-[860px]">
        <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
          <th className="py-1 pr-3 font-normal">Folio</th><th className="pr-3 font-normal">Fecha</th><th className="pr-3 font-normal">Cliente</th>
          <th className="pr-3 font-normal text-right">Efectivo</th><th className="pr-3 font-normal text-right">Tarjeta</th>
          <th className="pr-3 font-normal text-right">Transferencia</th>{t.otro ? <th className="pr-3 font-normal text-right">Otro</th> : null}
          <th className="pr-3 font-normal text-right">Total</th><th className="font-normal">Estatus</th></tr></thead>
        <tbody>
          {ventas.map((v) => {
            const p = pagoDe(v); const c = v.estado === "cancelada"; const e = estatusCorte(v);
            return (
              <tr key={v.id} className={`border-b border-[var(--borde)] ${c ? "text-[var(--tenue)]" : ""}`}>
                <td className="py-1.5 pr-3 whitespace-nowrap"><a className="underline" href={`/ventas/${v.id}`} target="_blank" rel="noreferrer">{v.serie} {v.folio}</a></td>
                <td className="pr-3 whitespace-nowrap">{new Date(v.fecha).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit", month: "short" })}</td>
                <td className="pr-3">{v.cliente}</td>
                <td className="pr-3 text-right">{m(p.efectivo)}</td><td className="pr-3 text-right">{m(p.tarjeta)}</td>
                <td className="pr-3 text-right">{m(p.transferencia)}</td>{t.otro ? <td className="pr-3 text-right">{m(p.otro)}</td> : null}
                <td className="pr-3 text-right">{c ? "$0.00" : v.anterior ? "" : $(v.total)}</td>
                <td className="whitespace-nowrap"><span className={`px-1.5 rounded text-xs ${color[e]}`}>{e}</span>
                  {!c && !v.anterior && Number(v.saldo) > 0 && <span className="text-xs text-[var(--tenue)]"> {$(v.saldo)}</span>}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot><tr className="font-semibold border-t-2" style={{ borderColor: "var(--acento)" }}>
          <td className="py-1.5 pr-3" colSpan={3}>{t.num} venta{t.num === 1 ? "" : "s"}{t.canceladas ? ` · ${t.canceladas} cancelada${t.canceladas === 1 ? "" : "s"}` : ""}</td>
          <td className="pr-3 text-right">{$(t.efectivo)}</td><td className="pr-3 text-right">{$(t.tarjeta)}</td><td className="pr-3 text-right">{$(t.transferencia)}</td>
          {t.otro ? <td className="pr-3 text-right">{$(t.otro)}</td> : null}<td className="pr-3 text-right">{$(t.total)}</td>
          <td className="text-xs font-normal">{t.porCobrar ? `Por cobrar ${$(t.porCobrar)}` : ""}</td></tr></tfoot>
      </table>
    </div>
  );
}

/** Cuadre de efectivo renglón por renglón */
function Cuadre({ r, contado }: { r: Resumen; contado?: number | null }) {
  return (
    <div className="text-sm">
      {cuadreEfectivo(r, contado).map((x, i) => (
        <div key={i} className={`flex justify-between gap-3 px-2 py-1 ${x.fuerte ? "mt-1 text-white font-semibold rounded" : "border-b border-[var(--borde)]"}`}
          style={x.fuerte ? { background: "var(--acento)" } : undefined}>
          <span>{x.signo === "=" ? "" : `(${x.signo === "±" ? (x.importe < 0 ? "−" : "+") : x.signo}) `}{x.texto}
            {x.detalle && <span className="text-xs text-[var(--tenue)]"> · {x.detalle}</span>}</span>
          <span className={`whitespace-nowrap ${!x.fuerte && (x.signo === "−" || x.importe < 0) ? "text-[var(--peligro)]" : ""}`}>{$(Math.abs(x.importe))}</span>
        </div>
      ))}
    </div>
  );
}

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

const diaMx = (d: Date | string) => new Date(d).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
/** Suma días a una fecha "AAAA-MM-DD" */
const masDias = (f: string, n: number) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSemana = (f: string) => new Date(`${f}T12:00:00Z`).getUTCDay(); // 0 domingo … 6 sábado
/** Periodos comunes, relativos a hoy */
function periodos(): { texto: string; desde: string; hasta: string }[] {
  const hoy = diaMx(new Date());
  const lunes = masDias(hoy, -((diaSemana(hoy) + 6) % 7));
  const min = (a: string, b: string) => (a < b ? a : b);
  const sab = masDias(hoy, -((diaSemana(hoy) + 1) % 7));   // último sábado (hoy si es sábado)
  return [
    { texto: "Lunes a viernes", desde: lunes, hasta: min(masDias(lunes, 4), hoy) },
    { texto: "Lunes a sábado", desde: lunes, hasta: min(masDias(lunes, 5), hoy) },
    { texto: "Sábado a sábado", desde: masDias(sab, -7), hasta: sab },
  ];
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
    categoria: string; forma: string; proveedor: string; fecha: string; conFactura?: boolean; folio?: string } | null>(null);
  const nuevoMov = (tipo: "retiro" | "gasto") => setRetiro({ clave: crypto.randomUUID(), tipo, importe: "", concepto: "", categoria: "", forma: "efectivo", proveedor: "",
    fecha: new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }) });
  const [abierto, setAbierto] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [clave, setClave] = useState(() => crypto.randomUUID());
  // null = periodo por omisión (desde el último corte hasta ahora)
  const [fechas, setFechas] = useState<{ desde: string; hasta: string } | null>(null);
  const [empresa, setEmpresa] = useState("");
  useEffect(() => { cargarEmpresa().then((e) => setEmpresa(e.nombre_emisor || e.razon_social || "")).catch(() => {}); }, []);

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
        sb.rpc("corte_resumen", { p: { sucursal_id: sucursal, ...(fechas ?? {}) } }),
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
  }, [sucursal, fechas]);
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
        ...(retiro.conFactura ? { con_factura: true, factura_folio: retiro.folio?.trim() || null } : {}),
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
    if (!window.confirm(`¿Cerrar el corte?\n\nDel ${fechaMx(r.desde)} al ${fechaMx(r.hasta)}\nTotal general: ${$(r.total_general)}\nEfectivo esperado: ${$(r.efectivo_esperado)}\nEfectivo contado: ${$(contado)}\nDiferencia: ${$(diferencia ?? 0)}`)) return;
    setTrabajando(true);
    try {
      const { data, error } = await supabase().rpc("cerrar_corte", { p: { idempotency_key: clave, sucursal_id: sucursal, efectivo_contado: contado, notas: notas || null, ...(fechas ?? {}) } });
      if (error) throw error;
      setContado(""); setNotas(""); setClave(crypto.randomUUID()); setFechas(null);
      setMsg({ tipo: "ok", texto: `Corte ${data.serie} ${data.folio} cerrado.` });
      await cargar();
      setAbierto(data.corte_id);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  const sucNombre = () => { const x = sucursales.find((y) => y.id === sucursal); return x ? `${x.codigo} - ${x.nombre}` : ""; };
  const datosDe = (c: Corte): DatosCorte => ({ titulo: `Corte de caja ${c.serie} ${c.folio}`, sucursal: sucNombre(), empresa,
    realizo: c.usuario_id ? nombres[c.usuario_id] ?? "" : "", contado: Number(c.efectivo_contado), notas: c.notas });
  const datosEnCurso = (): DatosCorte => ({ titulo: "Corte de caja (en curso)", sucursal: sucNombre(), empresa, contado: contado === "" ? null : Number(contado), notas });
  const archivo = (folio: string, hasta: string) => `Corte_${(sucursales.find((y) => y.id === sucursal)?.codigo ?? "")}_${folio}_${new Date(hasta).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" })}.xlsx`;
  const imprimir = (c: Corte) => imprimirCorte(c.resumen, datosDe(c));

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      {msg && (msg.tipo === "ok"
        ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-md px-4 py-2 text-sm shadow-lg bg-emerald-600 text-white">✓ {msg.texto}</div>
        : <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>)}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Corte de caja</h1>
        <label className="text-sm">Sucursal
          <select className="campo !w-auto" value={sucursal} onChange={(e) => { setSucursal(e.target.value); setFechas(null); }}>
            {sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}
          </select>
        </label>
      </div>

      {!r && !msg && <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4"><EsqueletoTabla columnas={7} filas={8} /></section>}
      {r && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-4">
          <div className="flex justify-between flex-wrap gap-2 items-baseline">
            <div className="barra-seccion flex-1">Corte en curso</div>
            <span className="text-sm text-[var(--tenue)]">Del {fechaMx(r.desde)} al {fechaMx(r.hasta)}</span>
          </div>
          {(() => {
            const hoy = diaMx(new Date());
            const d = fechas?.desde ?? diaMx(r.desde), h = fechas?.hasta ?? hoy;
            const minimo = r.ultimo_corte ? diaMx(r.ultimo_corte) : undefined;
            const hueco = r.ultimo_corte && new Date(r.desde).getTime() - new Date(r.ultimo_corte).getTime() > 1000;
            return (
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-end gap-3">
                  <label>Desde<input type="date" className="campo !w-auto" value={d} min={minimo} max={h} onChange={(e) => e.target.value && setFechas({ desde: e.target.value, hasta: h })} /></label>
                  <label>Hasta<input type="date" className="campo !w-auto" value={h} min={d} max={hoy} onChange={(e) => e.target.value && setFechas({ desde: d, hasta: e.target.value })} /></label>
                  <div className="flex flex-wrap gap-1.5">
                    {periodos().map((x) => (
                      <button key={x.texto} className={`px-2.5 py-1.5 rounded border text-xs ${fechas?.desde === x.desde && fechas?.hasta === x.hasta ? "border-[var(--acento)] bg-[var(--resalte)]" : "border-[var(--borde)]"}`}
                        onClick={() => setFechas({ desde: x.desde, hasta: x.hasta })}>{x.texto}</button>
                    ))}
                    <button className={`px-2.5 py-1.5 rounded border text-xs ${!fechas ? "border-[var(--acento)] bg-[var(--resalte)]" : "border-[var(--borde)]"}`} onClick={() => setFechas(null)}>Desde el último corte</button>
                  </div>
                </div>
                {r.ultimo_corte && <div className="text-xs text-[var(--tenue)]">El último corte terminó el {fechaMx(r.ultimo_corte)}; este corte no puede empezar antes.</div>}
                {hueco && <div className="rounded px-3 py-1.5 bg-amber-100 text-amber-900 text-xs">Lo que pasó del {fechaMx(r.ultimo_corte!)} al {fechaMx(r.desde)} no quedará en ningún corte.</div>}
                {h < hoy && <div className="text-xs text-[var(--tenue)]">Lo posterior al {h.split("-").reverse().join("/")} quedará para el siguiente corte.</div>}
              </div>
            );
          })()}
          <div className="flex gap-2 justify-end -mt-2">
            <button className="px-3 py-1.5 rounded border border-[var(--borde)] text-sm" onClick={() => imprimirCorte(r, datosEnCurso())}>Imprimir</button>
            <button className="px-3 py-1.5 rounded border border-[var(--borde)] text-sm" onClick={() => excelCorte(r, datosEnCurso(), archivo("en-curso", r.hasta))}>Exportar a Excel</button>
          </div>
          {r.ventas !== undefined
            ? <div><h2 className="font-medium mb-1">Ventas</h2><VentasCorte ventas={r.ventas} /></div>
            : <div className="text-sm text-[var(--tenue)]">{AVISO_SIN_VENTAS}</div>}
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
              <h2 className="font-medium mb-1">Cuadre de efectivo</h2>
              <Cuadre r={r} contado={contado === "" ? null : Number(contado)} />
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
                      <div className="flex justify-end"><button className="px-3 py-1.5 rounded border border-[var(--borde)] text-sm" onClick={() => excelCorte(c.resumen, datosDe(c), archivo(`${c.serie}${c.folio}`, c.hasta))}>Exportar a Excel</button></div>
                      {c.resumen.ventas ? <VentasCorte ventas={c.resumen.ventas} /> : <div className="text-sm text-[var(--tenue)]">{AVISO_SIN_VENTAS}</div>}
                      <div className="grid gap-4 lg:grid-cols-2"><div /><Cuadre r={c.resumen} contado={Number(c.efectivo_contado)} /></div>
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
                <label>Fecha<input type="date" className="campo" value={retiro.fecha} min={r?.ultimo_corte ? diaMx(r.ultimo_corte) : undefined} max={diaMx(new Date())} onChange={(e) => setRetiro({ ...retiro, fecha: e.target.value })} /></label>
                <label className="sm:col-span-2">Proveedor / a quién se pagó (opcional)<input className="campo" value={retiro.proveedor} onChange={(e) => setRetiro({ ...retiro, proveedor: e.target.value })} /></label>
                <label className="sm:col-span-2 flex items-center gap-2"><input type="checkbox" checked={!!retiro.conFactura} onChange={(e) => setRetiro({ ...retiro, conFactura: e.target.checked })} />
                  Trae factura (para la contadora: gasto deducible)</label>
                {retiro.conFactura && <label className="sm:col-span-2">Folio fiscal (UUID) de la factura (opcional)
                  <input className="campo uppercase" placeholder="p. ej. 1A2B3C4D-…" value={retiro.folio ?? ""} onChange={(e) => setRetiro({ ...retiro, folio: e.target.value })} /></label>}
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
