"use client";
/**
 * Agenda de envíos / pedidos: lo ven todos los usuarios.
 * Vista de semana (tarjetas por día, color por prioridad) o lista. Un envío lleva día, hora opcional, destino,
 * prioridad, contacto, chofer/vehículo, notas de venta ligadas (una o varias) o lo que se lleva, y quién lo agendó.
 * Estados: programado → en ruta → entregado (quién recibió) / cancelado (motivo). ?nuevo=1&ventas=id,id abre la captura.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { fechaMx, nombresUsuarios } from "@/lib/documentoVenta";
import { useSoloConsulta } from "@/lib/rol";
import { IconoEditar } from "@/components/Iconos";

type Prioridad = "baja" | "normal" | "alta" | "urgente";
type Estado = "programado" | "en_ruta" | "entregado" | "cancelado";
interface Envio {
  id: string; numero: number; sucursal_id: string | null; cliente_id: string | null; fecha: string; hora: string | null; destino: string; direccion: string | null;
  contacto: string | null; telefono: string | null; prioridad: Prioridad; estado: Estado; chofer: string | null; vehiculo: string | null; contenido: string | null;
  notas: string | null; creado_por: string | null; creado_en: string; actualizado_por: string | null; actualizado_en: string | null; entregado_en: string | null;
  recibio: string | null; motivo_cancelacion: string | null;
  clientes: { nombre: string; razon_social: string | null } | null; sucursales: { codigo: string } | null;
}
interface NotaEnvio { envio_id: string; venta_id: string; serie: string; folio: number; cliente: string; total: number; saldo: number; estado: string; por_entregar: boolean; sucursal: string }
interface NotaElegida { id: string; serie: string; folio: number; cliente: string; total: number; telefono?: string | null }
type Form = { id?: string; clave: string; fecha: string; hora: string; destino: string; direccion: string; contacto: string; telefono: string; prioridad: Prioridad;
  sucursal_id: string; chofer: string; vehiculo: string; contenido: string; notas: string; ventas: NotaElegida[] };

const PRIORIDAD: Record<Prioridad, { t: string; barra: string; chip: string }> = {
  urgente: { t: "Urgente", barra: "#b42318", chip: "bg-red-100 text-red-800" }, alta: { t: "Alta", barra: "#d97706", chip: "bg-amber-100 text-amber-900" },
  normal: { t: "Normal", barra: "#0f766e", chip: "bg-emerald-50 text-emerald-900" }, baja: { t: "Baja", barra: "#94a3b8", chip: "bg-slate-100 text-slate-700" },
};
const ESTADO: Record<Estado, { t: string; cls: string }> = {
  programado: { t: "Programado", cls: "bg-sky-100 text-sky-900" }, en_ruta: { t: "En ruta", cls: "bg-amber-100 text-amber-900" },
  entregado: { t: "Entregado", cls: "bg-emerald-100 text-emerald-900" }, cancelado: { t: "Cancelado", cls: "bg-gray-200 text-gray-700" },
};
const ORDEN_P: Record<Prioridad, number> = { urgente: 0, alta: 1, normal: 2, baja: 3 };
const tz = { timeZone: "America/Mexico_City" } as const;
const hoy = () => new Date().toLocaleDateString("en-CA", tz);
const masDias = (d: string, n: number) => { const x = new Date(`${d}T12:00:00`); x.setDate(x.getDate() + n); return x.toLocaleDateString("en-CA"); };
const lunesDe = (d: string) => { const x = new Date(`${d}T12:00:00`); const w = (x.getDay() + 6) % 7; return masDias(d, -w); };
const diaLargo = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("es-MX", { weekday: "long", day: "numeric", month: "long" });
const diaCorto = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("es-MX", { weekday: "short", day: "numeric", month: "short" });
const $ = (n: number) => `$${fmtImporte(n)}`;
const formVacio = (fecha = hoy()): Form => ({ clave: crypto.randomUUID(), fecha, hora: "", destino: "", direccion: "", contacto: "", telefono: "", prioridad: "normal",
  sucursal_id: "", chofer: "", vehiculo: "", contenido: "", notas: "", ventas: [] });

export default function Agenda() {
  const solo = useSoloConsulta();
  const [vista, setVista] = useState<"semana" | "lista">("semana");
  const [lunes, setLunes] = useState(lunesDe(hoy()));
  const [desde, setDesde] = useState(hoy());
  const [hasta, setHasta] = useState(masDias(hoy(), 30));
  const [verTodos, setVerTodos] = useState(false);   // incluir entregados y cancelados
  const [sucursal, setSucursal] = useState("");
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  const [envios, setEnvios] = useState<Envio[]>([]);
  const [notas, setNotas] = useState<Record<string, NotaEnvio[]>>({});
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [detalle, setDetalle] = useState<Envio | null>(null);
  const [historial, setHistorial] = useState<{ fecha: string; accion: string; usuario: string; detalle: Record<string, unknown> }[] | null>(null);
  const [trabajando, setTrabajando] = useState(false);
  const [busca, setBusca] = useState<{ texto: string; lista: NotaElegida[] }>({ texto: "", lista: [] });
  const [masDatos, setMasDatos] = useState(false);   // el desplegable de datos opcionales

  const rango = vista === "semana" ? { d: lunes, h: masDias(lunes, 6) } : { d: desde, h: hasta };

  useEffect(() => {
    supabase().from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")
      .then(({ data }: { data: unknown }) => setSucursales((data ?? []) as { id: string; codigo: string; nombre: string }[]));
    // Viene de una nota: ?nuevo=1&ventas=id,id
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("nuevo")) {
      const ids = (qs.get("ventas") ?? "").split(",").filter(Boolean);
      (async () => {
        const f = formVacio();
        if (ids.length) {
          const { data } = await supabase().from("ventas").select("id, serie, folio, total, sucursal_id, clientes(nombre, razon_social, direccion, telefono)").in("id", ids);
          const vs = (data ?? []) as unknown as { id: string; serie: string; folio: number; total: string; sucursal_id: string; clientes: { nombre: string; razon_social: string | null; direccion: string | null; telefono: string | null } | null }[];
          f.ventas = vs.map((v) => ({ id: v.id, serie: v.serie, folio: v.folio, cliente: v.clientes?.razon_social || v.clientes?.nombre || "", total: Number(v.total) }));
          f.sucursal_id = vs[0]?.sucursal_id ?? "";
          f.direccion = vs[0]?.clientes?.direccion ?? ""; f.telefono = vs[0]?.clientes?.telefono ?? "";
        }
        setMasDatos(ids.length > 0);
        setForm(f);
      })();
    }
  }, []);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const sb = supabase();
      let q = sb.from("envios").select("*, clientes(nombre, razon_social), sucursales(codigo)").gte("fecha", rango.d).lte("fecha", rango.h).order("fecha").limit(1000);
      if (!verTodos) q = q.in("estado", ["programado", "en_ruta"]);
      if (sucursal) q = q.eq("sucursal_id", sucursal);
      const { data, error } = await q;
      if (error) {
        if (/envios/.test(error.message)) throw new Error("Falta ejecutar la migración 20261123000059_agenda_envios.sql en Supabase.");
        throw error;
      }
      const es = (data ?? []) as unknown as Envio[];
      setEnvios(es);
      if (es.length) {
        const { data: ns } = await sb.rpc("envio_notas", { p_envios: es.map((e) => e.id) });
        const m: Record<string, NotaEnvio[]> = {};
        for (const n of (ns ?? []) as NotaEnvio[]) (m[n.envio_id] ??= []).push(n);
        setNotas(m);
        const ids = es.flatMap((e) => [e.creado_por, e.actualizado_por]).filter((x): x is string => !!x);
        if (ids.length) setNombres(await nombresUsuarios(ids));
      } else setNotas({});
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [rango.d, rango.h, verTodos, sucursal]);
  useEffect(() => { cargar(); }, [cargar]);

  // Buscar notas para ligar (por folio o cliente)
  useEffect(() => {
    const t = busca.texto.trim().replace(/[%,()]/g, "");
    if (t.length < 2) { setBusca((b) => ({ ...b, lista: [] })); return; }
    const h = setTimeout(async () => {
      const sb = supabase();
      let q = sb.from("ventas").select("id, serie, folio, total, clientes(nombre, razon_social, telefono)").eq("estado", "confirmada").order("fecha", { ascending: false }).limit(12);
      const folio = /^([A-Za-z]*)\s*-?\s*(\d+)$/.exec(t);
      if (folio) { q = q.eq("folio", Number(folio[2])); if (folio[1]) q = q.ilike("serie", folio[1]); }
      else {
        const { data: cl } = await sb.from("clientes").select("id").or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,telefono.ilike.%${t}%`).limit(100);
        q = q.in("cliente_id", ((cl ?? []) as { id: string }[]).map((c) => c.id).concat(["00000000-0000-0000-0000-000000000000"]));
      }
      const { data } = await q;
      setBusca((b) => ({ ...b, lista: ((data ?? []) as unknown as { id: string; serie: string; folio: number; total: string; clientes: { nombre: string; razon_social: string | null; telefono: string | null } | null }[])
        .map((v) => ({ id: v.id, serie: v.serie, folio: v.folio, cliente: v.clientes?.razon_social || v.clientes?.nombre || "", total: Number(v.total), telefono: v.clientes?.telefono ?? null })) }));
    }, 250);
    return () => clearTimeout(h);
  }, [busca.texto]);

  const guardar = async () => {
    if (!form) return;
    setTrabajando(true); setMsg(null);
    try {
      const { data, error } = await supabase().rpc("guardar_envio", { p: { id: form.id ?? null, idempotency_key: form.clave, fecha: form.fecha, hora: form.hora, destino: form.destino,
        direccion: form.direccion, contacto: form.contacto, telefono: form.telefono, prioridad: form.prioridad, sucursal_id: form.sucursal_id || null,
        chofer: form.chofer, vehiculo: form.vehiculo, contenido: form.contenido, notas: form.notas, ventas: form.ventas.map((v) => v.id) } });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: form.id ? "Envío actualizado." : `Envío #${data.numero} agendado para el ${diaLargo(form.fecha)}.` });
      if (vista === "semana" && (form.fecha < lunes || form.fecha > masDias(lunes, 6))) setLunes(lunesDe(form.fecha));
      setForm(null); setDetalle(null); await cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); setForm((f) => f && ({ ...f, clave: crypto.randomUUID() })); } finally { setTrabajando(false); }
  };

  const cambiarEstado = async (e: Envio, estado: Estado) => {
    let extra: Record<string, string> = {};
    if (estado === "cancelado") { const m = window.prompt("Motivo de la cancelación:"); if (!m?.trim()) return; extra = { motivo: m.trim() }; }
    if (estado === "entregado") { const r = window.prompt("¿Quién recibió? (opcional)") ; if (r === null) return; extra = { recibio: r }; }
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("cambiar_estado_envio", { p: { envio_id: e.id, estado, ...extra } });
      if (error) throw error;
      setMsg({ tipo: "ok", texto: `Envío #${e.numero}: ${ESTADO[estado].t.toLowerCase()}.` }); setDetalle(null); await cargar();
    } catch (err) { setMsg({ tipo: "error", texto: mensajeError(err) }); } finally { setTrabajando(false); }
  };

  const abrirDetalle = async (e: Envio) => {
    setDetalle(e); setHistorial(null);
    const { data } = await supabase().rpc("historial_envio", { p_envio: e.id });
    setHistorial((data ?? []) as typeof historial);
  };
  const nuevo = (fecha: string) => { setMasDatos(false); setForm(formVacio(fecha)); };
  const editar = (e: Envio) => { setMasDatos(true); setForm({ id: e.id, clave: crypto.randomUUID(), fecha: e.fecha, hora: e.hora ?? "", destino: e.destino, direccion: e.direccion ?? "",
    contacto: e.contacto ?? "", telefono: e.telefono ?? "", prioridad: e.prioridad, sucursal_id: e.sucursal_id ?? "", chofer: e.chofer ?? "", vehiculo: e.vehiculo ?? "",
    contenido: e.contenido ?? "", notas: e.notas ?? "", ventas: (notas[e.id] ?? []).map((n) => ({ id: n.venta_id, serie: n.serie, folio: n.folio, cliente: n.cliente, total: Number(n.total) })) }); };

  const porDia = useMemo(() => {
    const m = new Map<string, Envio[]>();
    for (const e of envios) (m.get(e.fecha) ?? m.set(e.fecha, []).get(e.fecha)!).push(e);
    for (const l of m.values()) l.sort((a, b) => ORDEN_P[a.prioridad] - ORDEN_P[b.prioridad] || (a.hora ?? "").localeCompare(b.hora ?? ""));
    return m;
  }, [envios]);
  const dias = Array.from({ length: 7 }, (_, i) => masDias(lunes, i));
  const atrasados = envios.filter((e) => e.fecha < hoy() && (e.estado === "programado" || e.estado === "en_ruta")).length;

  const Tarjeta = ({ e }: { e: Envio }) => {
    const ns = notas[e.id] ?? [];
    return (
      <button onClick={() => abrirDetalle(e)} className={`w-full text-left rounded border border-[var(--borde)] bg-[var(--panel)] p-2 text-xs hover:shadow flex gap-2 ${e.estado === "cancelado" ? "opacity-50" : ""}`}>
        <span className="w-1 rounded shrink-0" style={{ background: PRIORIDAD[e.prioridad].barra }} />
        <span className="flex-1 min-w-0">
          <span className="flex justify-between gap-1"><b className="truncate">{e.destino}</b><span className="text-[var(--tenue)] shrink-0">#{e.numero}</span></span>
          {e.hora && <span className="block">🕒 {e.hora}</span>}
          {(e.clientes || ns[0]) && <span className="block truncate">{e.clientes?.razon_social || e.clientes?.nombre || ns[0]?.cliente}</span>}
          <span className="block text-[var(--tenue)] truncate">{ns.length ? ns.map((n) => `${n.serie} ${n.folio}`).join(", ") : e.contenido}</span>
          <span className="flex gap-1 mt-1 flex-wrap">
            {e.prioridad !== "normal" && <span className={`px-1 rounded ${PRIORIDAD[e.prioridad].chip}`}>{PRIORIDAD[e.prioridad].t}</span>}
            <span className={`px-1 rounded ${ESTADO[e.estado].cls}`}>{ESTADO[e.estado].t}</span>
          </span>
        </span>
      </button>
    );
  };

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Agenda de envíos</h1>
        {!solo && <button className="btn-primario" onClick={() => nuevo(vista === "semana" && lunes > hoy() ? lunes : hoy())}>+ Agendar envío</button>}
      </div>
      {msg && <div role={msg.tipo === "ok" ? "status" : "alert"} className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}
      {atrasados > 0 && <div className="rounded px-4 py-2 bg-red-50 text-red-800 border border-red-200 text-sm">Hay {atrasados} envío{atrasados === 1 ? "" : "s"} de días anteriores sin marcar como entregado{atrasados === 1 ? "" : "s"}.</div>}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 flex flex-wrap gap-3 items-end text-sm">
        <div className="flex rounded border border-[var(--borde)] overflow-hidden">
          {(["semana", "lista"] as const).map((v) => <button key={v} className={`px-3 py-1.5 ${vista === v ? "bg-[var(--acento)] text-white" : ""}`} onClick={() => setVista(v)}>{v === "semana" ? "Semana" : "Lista"}</button>)}
        </div>
        {vista === "semana" ? (
          <div className="flex items-center gap-2">
            <button className="px-2 py-1 rounded border border-[var(--borde)]" aria-label="Semana anterior" onClick={() => setLunes(masDias(lunes, -7))}>←</button>
            <button className="px-2 py-1 rounded border border-[var(--borde)]" onClick={() => setLunes(lunesDe(hoy()))}>Hoy</button>
            <button className="px-2 py-1 rounded border border-[var(--borde)]" aria-label="Semana siguiente" onClick={() => setLunes(masDias(lunes, 7))}>→</button>
            <span className="font-medium">{diaCorto(lunes)} – {diaCorto(masDias(lunes, 6))}</span>
          </div>
        ) : (<>
          <label>Desde<input type="date" className="campo" value={desde} onChange={(e) => setDesde(e.target.value)} /></label>
          <label>Hasta<input type="date" className="campo" value={hasta} onChange={(e) => setHasta(e.target.value)} /></label>
        </>)}
        <label>Sale de<select className="campo" value={sucursal} onChange={(e) => setSucursal(e.target.value)}>
          <option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}</select></label>
        <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={verTodos} onChange={(e) => setVerTodos(e.target.checked)} /> Ver también entregados y cancelados</label>
      </section>

      {vista === "semana" ? (
        <div className="grid gap-2 md:grid-cols-7">
          {dias.map((d) => (
            <div key={d} className={`rounded-md border p-2 min-h-32 flex flex-col gap-2 ${d === hoy() ? "border-[var(--acento)] bg-[var(--resalte)]/40" : "border-[var(--borde)] bg-[var(--panel)]"}`}>
              <div className="flex justify-between items-center text-xs">
                <span className={`capitalize ${d === hoy() ? "font-semibold text-[var(--acento)]" : "text-[var(--tenue)]"}`}>{diaCorto(d)}{d === hoy() ? " · hoy" : ""}</span>
                {!solo && <button className="text-[var(--acento)] text-base leading-none" title={`Agendar para el ${diaLargo(d)}`} onClick={() => nuevo(d)}>＋</button>}
              </div>
              {(porDia.get(d) ?? []).map((e) => <Tarjeta key={e.id} e={e} />)}
              {cargando && !envios.length && <div className="h-10 rounded bg-[var(--borde)] animate-pulse" />}
            </div>
          ))}
        </div>
      ) : (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
          <table className="w-full text-sm min-w-[860px]">
            <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">Día</th><th className="font-normal">Destino</th><th className="font-normal">Cliente / qué va</th><th className="font-normal">Prioridad</th>
              <th className="font-normal">Estado</th><th className="font-normal">Agendó</th></tr></thead>
            <tbody>
              {envios.map((e) => {
                const ns = notas[e.id] ?? [];
                return (
                  <tr key={e.id} className="border-b border-[var(--borde)] align-top cursor-pointer hover:bg-[var(--resalte)]" onClick={() => abrirDetalle(e)}>
                    <td className="p-2 whitespace-nowrap capitalize">{diaCorto(e.fecha)}{e.hora && <div className="text-xs text-[var(--tenue)]">{e.hora}</div>}</td>
                    <td className="py-2">{e.destino}<div className="text-xs text-[var(--tenue)]">#{e.numero}{e.sucursales ? ` · sale de ${e.sucursales.codigo}` : ""}</div></td>
                    <td className="py-2">{e.clientes?.razon_social || e.clientes?.nombre || ns[0]?.cliente || ""}
                      <div className="text-xs text-[var(--tenue)]">{ns.length ? ns.map((n) => `${n.serie} ${n.folio}`).join(", ") : e.contenido}</div></td>
                    <td className="py-2"><span className={`px-1.5 rounded text-xs ${PRIORIDAD[e.prioridad].chip}`}>{PRIORIDAD[e.prioridad].t}</span></td>
                    <td className="py-2"><span className={`px-1.5 rounded text-xs ${ESTADO[e.estado].cls}`}>{ESTADO[e.estado].t}</span></td>
                    <td className="py-2 text-xs">{e.creado_por ? nombres[e.creado_por] ?? "" : ""}<div className="text-[var(--tenue)]">{fechaMx(e.creado_en)}</div></td>
                  </tr>
                );
              })}
              {!cargando && !envios.length && <tr><td colSpan={6} className="p-6 text-center text-[var(--tenue)]">No hay envíos en ese periodo.</td></tr>}
            </tbody>
          </table>
        </section>
      )}

      {/* Detalle */}
      {detalle && !form && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setDetalle(null)}>
          <div role="dialog" aria-label="Detalle del envío" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-xl p-5 text-sm max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex justify-between items-start gap-3">
              <div>
                <h2 className="text-lg font-semibold">Envío #{detalle.numero} · {detalle.destino}</h2>
                <div className="capitalize">{diaLargo(detalle.fecha)}{detalle.hora ? ` · ${detalle.hora}` : ""}</div>
              </div>
              <div className="flex gap-1 flex-wrap justify-end">
                <span className={`px-1.5 rounded text-xs ${PRIORIDAD[detalle.prioridad].chip}`}>{PRIORIDAD[detalle.prioridad].t}</span>
                <span className={`px-1.5 rounded text-xs ${ESTADO[detalle.estado].cls}`}>{ESTADO[detalle.estado].t}</span>
              </div>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-3">
              {detalle.direccion && <><dt className="text-[var(--tenue)]">Dirección</dt><dd>{detalle.direccion}</dd></>}
              {detalle.telefono && <><dt className="text-[var(--tenue)]">Teléfono del cliente</dt><dd><a className="underline" href={`tel:${detalle.telefono}`}>{detalle.telefono}</a>{detalle.contacto ? ` · ${detalle.contacto}` : ""}</dd></>}
              {detalle.sucursales && <><dt className="text-[var(--tenue)]">Sale de</dt><dd>{detalle.sucursales.codigo}</dd></>}
              {(detalle.chofer || detalle.vehiculo) && <><dt className="text-[var(--tenue)]">Chofer / vehículo</dt><dd>{[detalle.chofer, detalle.vehiculo].filter(Boolean).join(" · ")}</dd></>}
              {detalle.contenido && <><dt className="text-[var(--tenue)]">Lleva</dt><dd>{detalle.contenido}</dd></>}
              {detalle.notas && <><dt className="text-[var(--tenue)]">Notas</dt><dd>{detalle.notas}</dd></>}
              <dt className="text-[var(--tenue)]">Agendó</dt><dd>{detalle.creado_por ? nombres[detalle.creado_por] ?? "" : ""} · {fechaMx(detalle.creado_en)}</dd>
              {detalle.actualizado_en && <><dt className="text-[var(--tenue)]">Último cambio</dt><dd>{detalle.actualizado_por ? nombres[detalle.actualizado_por] ?? "" : ""} · {fechaMx(detalle.actualizado_en)}</dd></>}
              {detalle.estado === "entregado" && <><dt className="text-[var(--tenue)]">Entregado</dt><dd>{detalle.entregado_en ? fechaMx(detalle.entregado_en) : ""}{detalle.recibio ? ` · recibió ${detalle.recibio}` : ""}</dd></>}
              {detalle.estado === "cancelado" && <><dt className="text-[var(--tenue)]">Cancelado</dt><dd>{detalle.motivo_cancelacion}</dd></>}
            </dl>
            {(notas[detalle.id] ?? []).length > 0 && (
              <div className="mt-3">
                <h3 className="font-medium mb-1">Notas</h3>
                {(notas[detalle.id] ?? []).map((n) => (
                  <div key={n.venta_id} className="flex justify-between gap-3 py-1 border-b border-[var(--borde)]">
                    <span><Link className="underline" href={`/ventas/${n.venta_id}`}>{n.serie} {n.folio}</Link> <span className="text-xs text-[var(--tenue)]">{n.sucursal} · {n.cliente}</span>
                      {n.por_entregar && <span className="ml-1 text-xs px-1 rounded bg-amber-100 text-amber-900">material por entregar</span>}
                      {n.estado === "cancelada" && <span className="ml-1 text-xs px-1 rounded bg-gray-200">cancelada</span>}</span>
                    <span className="whitespace-nowrap">{$(Number(n.total))}{Number(n.saldo) > 0 && <span className="text-xs text-amber-700"> · debe {$(Number(n.saldo))}</span>}</span>
                  </div>
                ))}
                {(notas[detalle.id] ?? []).some((n) => Number(n.saldo) > 0) && <p className="text-xs text-amber-800 mt-1">Hay notas con saldo: confirma si se cobra al entregar.</p>}
              </div>
            )}
            {historial && historial.length > 0 && (
              <details className="mt-3"><summary className="cursor-pointer text-[var(--acento)]">Historial ({historial.length})</summary>
                <ul className="mt-1 text-xs flex flex-col gap-0.5">{historial.map((h, i) => (
                  <li key={i}>{fechaMx(h.fecha)} · {h.usuario} · {h.accion === "crear" ? "lo agendó" : h.accion === "editar" ? "lo modificó" : `lo marcó como ${ESTADO[(h.detalle.estado as Estado) ?? "programado"]?.t.toLowerCase() ?? h.detalle.estado}`}</li>
                ))}</ul></details>
            )}
            <div className="flex flex-wrap justify-end gap-2 mt-4">
              <button className="px-3 py-2 rounded border border-[var(--borde)]" onClick={() => setDetalle(null)}>Cerrar</button>
              {!solo && (detalle.estado === "programado" || detalle.estado === "en_ruta") && <>
                <button className="px-3 py-2 rounded border border-[var(--peligro)] text-[var(--peligro)]" disabled={trabajando} onClick={() => cambiarEstado(detalle, "cancelado")}>Cancelar envío</button>
                <button className="px-3 py-2 rounded border border-[var(--acento)] text-[var(--acento)] inline-flex items-center gap-1" onClick={() => editar(detalle)}><IconoEditar /> Editar</button>
                {detalle.estado === "programado" && <button className="px-3 py-2 rounded border border-amber-600 text-amber-800" disabled={trabajando} onClick={() => cambiarEstado(detalle, "en_ruta")}>Salió (en ruta)</button>}
                <button className="btn-primario" disabled={trabajando} onClick={() => cambiarEstado(detalle, "entregado")}>Entregado</button>
              </>}
              {!solo && (detalle.estado === "entregado" || detalle.estado === "cancelado") &&
                <button className="px-3 py-2 rounded border border-[var(--borde)]" disabled={trabajando} onClick={() => cambiarEstado(detalle, "programado")}>Volver a programar</button>}
            </div>
          </div>
        </div>
      )}

      {/* Agendar / editar */}
      {form && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setForm(null)}>
          <div role="dialog" aria-label="Agendar envío" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-2xl p-5 text-sm max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">{form.id ? "Editar envío" : "Agendar envío"}</h2>
            <div className="grid gap-3 sm:grid-cols-[1fr_2fr_1fr] mt-3">
              <label>Día *<input type="date" className="campo" value={form.fecha} onChange={(e) => setForm({ ...form, fecha: e.target.value })} /></label>
              <label>¿A dónde? *<input className="campo" autoFocus placeholder="p. ej. Pinal de Amoles" value={form.destino} onChange={(e) => setForm({ ...form, destino: e.target.value })} /></label>
              <label>Prioridad<select className="campo" value={form.prioridad} onChange={(e) => setForm({ ...form, prioridad: e.target.value as Prioridad })}>
                {(Object.keys(PRIORIDAD) as Prioridad[]).map((k) => <option key={k} value={k}>{PRIORIDAD[k].t}</option>)}</select></label>
            </div>

            <button type="button" className="mt-4 w-full flex justify-between items-center px-3 py-2 rounded border border-[var(--borde)] hover:bg-[var(--resalte)]"
              aria-expanded={masDatos} onClick={() => setMasDatos(!masDatos)}>
              <span>Más datos (opcional){form.ventas.length ? ` · ${form.ventas.length} nota${form.ventas.length === 1 ? "" : "s"}` : ""}</span>
              <span className="text-[var(--tenue)]">{masDatos ? "▲" : "▼"}</span>
            </button>
            {masDatos && (
              <div className="border border-t-0 border-[var(--borde)] rounded-b p-3 flex flex-col gap-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <label>Hora<input className="campo" placeholder="p. ej. 9:00 o en la mañana" value={form.hora} onChange={(e) => setForm({ ...form, hora: e.target.value })} /></label>
                  <label>Teléfono del cliente<input className="campo" inputMode="tel" value={form.telefono} onChange={(e) => setForm({ ...form, telefono: e.target.value })} /></label>
                  <label>Sale de<select className="campo" value={form.sucursal_id} onChange={(e) => setForm({ ...form, sucursal_id: e.target.value })}>
                    <option value="">—</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.codigo} - {s.nombre}</option>)}</select></label>
                  <label className="sm:col-span-3">Dirección / referencias<input className="campo" value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} /></label>
                </div>
                <div>
                  <div className="font-medium">Notas de venta que van en el envío</div>
                  {form.ventas.map((v) => (
                    <div key={v.id} className="flex justify-between items-center gap-2 py-1 border-b border-[var(--borde)]">
                      <span>{v.serie} {v.folio} <span className="text-xs text-[var(--tenue)]">{v.cliente}</span></span>
                      <span className="flex items-center gap-3">{$(v.total)}<button className="text-[var(--peligro)]" aria-label="Quitar nota" onClick={() => setForm({ ...form, ventas: form.ventas.filter((x) => x.id !== v.id) })}>✕</button></span>
                    </div>
                  ))}
                  <div className="relative mt-1">
                    <input className="campo" placeholder="Agregar nota: folio (p. ej. AR 120) o cliente…" value={busca.texto} onChange={(e) => setBusca({ ...busca, texto: e.target.value })} />
                    {busca.lista.length > 0 && (
                      <ul className="absolute z-10 w-full bg-[var(--panel)] border border-[var(--borde)] shadow max-h-56 overflow-auto">
                        {busca.lista.filter((v) => !form.ventas.some((x) => x.id === v.id)).map((v) => (
                          <li key={v.id}><button className="w-full text-left px-2 py-1.5 hover:bg-[var(--resalte)]" onClick={() => {
                            setForm({ ...form, ventas: [...form.ventas, v], telefono: form.telefono || v.telefono || "" }); setBusca({ texto: "", lista: [] }); }}>
                            {v.serie} {v.folio} · {v.cliente} · {$(v.total)}</button></li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                <label>Qué se lleva o qué se va a hacer<input className="campo" placeholder="p. ej. 20 cajas de muestra, recoger material…" value={form.contenido} onChange={(e) => setForm({ ...form, contenido: e.target.value })} /></label>
                <label>Notas<textarea className="campo h-16" placeholder="Indicaciones, horario de recepción, cobrar al entregar…" value={form.notas} onChange={(e) => setForm({ ...form, notas: e.target.value })} /></label>
              </div>
            )}
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setForm(null)}>Cancelar</button>
              <button className="btn-primario" disabled={trabajando || !form.fecha || !form.destino.trim()} onClick={guardar}>
                {trabajando ? "Guardando…" : form.id ? "Guardar cambios" : "Agendar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
