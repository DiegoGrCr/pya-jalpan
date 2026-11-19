"use client";
/**
 * Ventas › Clientes › Ficha: datos del cliente, cartera (saldo a favor con sus movimientos y "Abonar"),
 * ventas (con lo que debe) y devoluciones.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO, fechaMx } from "@/lib/documentoVenta";
import EstatusVenta from "@/components/EstatusVenta";

interface Cliente { id: string; nombre: string; razon_social: string | null; rfc: string | null; telefono: string | null; correo_facturas: string | null; direccion: string | null; saldo_a_favor?: string; es_publico_general: boolean }
interface Mov { id: string; fecha: string; importe: string; saldo: string; concepto: string; forma: string | null; referencia: string | null; venta_id: string | null }
interface Venta { id: string; serie: string; folio: number; fecha: string; total: string; saldo: string; estado: string; cerrada?: boolean }
const RFC_VALIDO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;
const $ = (n: string | number) => `$${fmtImporte(Number(n))}`;

export default function FichaCliente() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<Cliente | null>(null);
  const [datos, setDatos] = useState<Cliente | null>(null);
  const [movs, setMovs] = useState<Mov[] | null>(null);
  const [ventas, setVentas] = useState<Venta[]>([]);
  const [pestana, setPestana] = useState<"cartera" | "ventas" | "datos">("cartera");
  const [abono, setAbono] = useState<{ clave: string; importe: string; forma: string; referencia: string; sucursal: string } | null>(null);
  const [sucursales, setSucursales] = useState<{ id: string; codigo: string; nombre: string }[]>([]);
  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      const { data } = await sb.from("usuario_sucursales").select("sucursales(id, codigo, nombre)").eq("user_id", user?.id ?? "");
      let suc = ((data ?? []) as unknown as { sucursales: { id: string; codigo: string; nombre: string } | null }[]).map((x) => x.sucursales).filter((x): x is { id: string; codigo: string; nombre: string } => !!x);
      if (!suc.length) suc = ((await sb.from("sucursales").select("id, codigo, nombre").eq("activa", true).order("codigo")).data ?? []) as { id: string; codigo: string; nombre: string }[];
      setSucursales(suc);
    })();
  }, []);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [trabajando, setTrabajando] = useState(false);

  const cargar = useCallback(async () => {
    const sb = supabase();
    let r = await sb.from("clientes").select("id, nombre, razon_social, rfc, telefono, correo_facturas, direccion, saldo_a_favor, es_publico_general").eq("id", id).maybeSingle();
    if (r.error) r = await sb.from("clientes").select("id, nombre, razon_social, rfc, telefono, correo_facturas, direccion, es_publico_general").eq("id", id).maybeSingle();
    if (r.error) { setMsg({ tipo: "error", texto: mensajeError(r.error) }); return; }
    setC(r.data as Cliente); setDatos(r.data as Cliente);
    const [m, v] = await Promise.all([
      sb.from("saldo_favor_movimientos").select("id, fecha, importe, saldo, concepto, forma, referencia, venta_id").eq("cliente_id", id).order("fecha", { ascending: false }).limit(200),
      sb.from("ventas").select("id, serie, folio, fecha, total, saldo, estado, cerrada").eq("cliente_id", id).order("fecha", { ascending: false }).limit(200),
    ]);
    setMovs(m.error ? null : (m.data ?? []) as Mov[]);
    setVentas((v.data ?? []) as Venta[]);
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);
  useEffect(() => { if (msg?.tipo !== "ok") return; const t = setTimeout(() => setMsg(null), 3500); return () => clearTimeout(t); }, [msg]);

  const guardarDatos = async () => {
    if (!datos) return;
    const rfc = (datos.rfc ?? "").trim().toUpperCase();
    if (!datos.nombre.trim()) { setMsg({ tipo: "error", texto: "El nombre es obligatorio." }); return; }
    if (rfc && !RFC_VALIDO.test(rfc)) { setMsg({ tipo: "error", texto: "El RFC no es válido." }); return; }
    setTrabajando(true);
    const { error } = await supabase().from("clientes").update({ nombre: datos.nombre.trim(), razon_social: datos.razon_social?.trim() || null, rfc: rfc || null,
      telefono: datos.telefono?.trim() || null, correo_facturas: datos.correo_facturas?.trim() || null, direccion: datos.direccion?.trim() || null }).eq("id", id);
    setTrabajando(false);
    if (error) { setMsg({ tipo: "error", texto: mensajeError(error) }); return; }
    setMsg({ tipo: "ok", texto: "Datos guardados." }); cargar();
  };

  const guardarAbono = async () => {
    if (!abono) return;
    setTrabajando(true);
    try {
      const { error } = await supabase().rpc("abonar_saldo_favor", { p: { idempotency_key: abono.clave, cliente_id: id, importe: abono.importe, forma: abono.forma, referencia: abono.referencia || null, sucursal_id: abono.sucursal || null } });
      if (error) {
        if (/abonar_saldo_favor/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000038_cartera_devoluciones.sql en Supabase.");
        throw error;
      }
      setAbono(null); setMsg({ tipo: "ok", texto: `Se abonaron ${$(abono.importe)} al saldo a favor.` }); cargar();
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setTrabajando(false); }
  };

  if (!c) return <div className="p-6 text-[var(--tenue)]">{msg?.texto ?? "Cargando cliente…"}</div>;
  const porCobrar = ventas.filter((v) => v.estado === "confirmada").reduce((s, v) => s + Number(v.saldo), 0);
  const conSaldo = ventas.filter((v) => v.estado === "confirmada" && Number(v.saldo) > 0);
  const set = (k: keyof Cliente, val: string) => setDatos((d) => (d ? { ...d, [k]: val } : d));

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      {msg && (msg.tipo === "ok"
        ? <div role="status" className="fixed bottom-4 right-4 z-50 rounded-md px-4 py-2 text-sm shadow-lg bg-emerald-600 text-white">✓ {msg.texto}</div>
        : <div role="alert" className="rounded px-4 py-2 bg-amber-100 text-amber-900">{msg.texto}</div>)}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">{c.razon_social || c.nombre}</h1>
        <div className="flex gap-3 items-center text-sm">
          <Link href="/ventas/capturar" className="btn-primario">Nueva venta</Link>
          <Link href="/ventas/clientes" className="underline">← Clientes</Link>
        </div>
      </div>

      <div className="grid gap-3 grid-cols-2 lg:grid-cols-4 text-sm">
        <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Saldo a favor</div>
          <div className="text-2xl font-semibold text-emerald-700">{$(c.saldo_a_favor ?? 0)}</div></div>
        <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Por cobrar</div>
          <div className={`text-2xl font-semibold ${porCobrar > 0 ? "text-amber-700" : ""}`}>{$(porCobrar)}</div>
          <div className="text-xs text-[var(--tenue)]">{conSaldo.length} venta{conSaldo.length === 1 ? "" : "s"} con saldo</div></div>
        <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">RFC</div><div className="text-lg">{c.rfc ?? "—"}</div></div>
        <div className="rounded-md border border-[var(--borde)] bg-[var(--panel)] p-3"><div className="text-[var(--tenue)]">Teléfono</div><div className="text-lg">{c.telefono ?? "—"}</div></div>
      </div>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] text-sm">
        <div className="flex gap-1 border-b border-[var(--borde)] px-4 pt-2">
          {(["cartera", "ventas", "datos"] as const).map((t) => (
            <button key={t} onClick={() => setPestana(t)} className={`px-3 py-1.5 rounded-t border border-b-0 ${pestana === t ? "border-[var(--borde)] font-semibold" : "border-transparent text-[var(--acento)]"}`}>
              {t === "cartera" ? "Saldo a favor" : t === "ventas" ? "Ventas" : "Datos"}
            </button>
          ))}
        </div>
        <div className="p-4">
          {pestana === "cartera" && (
            <>
              {movs === null ? <div className="text-[var(--tenue)]">Para ver la cartera falta ejecutar la migración 20261118000027 o 0038 en Supabase.</div> : <>
                <div className="flex justify-between items-center flex-wrap gap-2 mb-3">
                  <p className="text-[var(--tenue)]">El saldo a favor se usa al vender con la forma de pago “Saldo a favor”.</p>
                  {!c.es_publico_general && <button className="btn-primario" onClick={() => setAbono({ clave: crypto.randomUUID(), importe: "", forma: "efectivo", referencia: "", sucursal: sucursales[0]?.id ?? "" })}>Abonar a saldo a favor</button>}
                </div>
                <table className="w-full">
                  <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                    <th className="py-1 font-normal">Fecha</th><th className="font-normal">Concepto</th><th className="font-normal">Forma / referencia</th>
                    <th className="font-normal text-right">Movimiento</th><th className="font-normal text-right">Saldo</th></tr></thead>
                  <tbody>
                    {movs.map((m) => (
                      <tr key={m.id} className="border-b border-[var(--borde)]">
                        <td className="py-1.5 pr-3 whitespace-nowrap">{fechaMx(m.fecha)}</td>
                        <td className="pr-3">{m.concepto}{m.venta_id && <> · <Link className="underline" href={`/ventas/${m.venta_id}`}>ver venta</Link></>}</td>
                        <td className="pr-3">{[m.forma ? FORMAS_PAGO[m.forma] ?? m.forma : "", m.referencia ?? ""].filter(Boolean).join(" · ")}</td>
                        <td className={`pr-3 text-right ${Number(m.importe) > 0 ? "text-emerald-700" : "text-[var(--peligro)]"}`}>{Number(m.importe) > 0 ? "+" : "−"}{$(Math.abs(Number(m.importe)))}</td>
                        <td className="text-right">{$(m.saldo)}</td>
                      </tr>
                    ))}
                    {!movs.length && <tr><td colSpan={5} className="py-3 text-[var(--tenue)]">Sin movimientos de saldo a favor.</td></tr>}
                  </tbody>
                </table>
              </>}
            </>
          )}
          {pestana === "ventas" && (
            <table className="w-full">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="py-1 font-normal">#</th><th className="font-normal">Fecha</th><th className="font-normal text-right">Total</th><th className="font-normal text-right">Saldo</th><th className="font-normal pl-3">Estatus</th></tr></thead>
              <tbody>
                {ventas.map((v) => (
                  <tr key={v.id} className="border-b border-[var(--borde)]">
                    <td className="py-1.5 pr-3"><Link className="underline" href={`/ventas/${v.id}`}>{v.serie} {v.folio}</Link></td>
                    <td className="pr-3">{fechaMx(v.fecha)}</td><td className="pr-3 text-right">{$(v.total)}</td>
                    <td className={`pr-3 text-right ${Number(v.saldo) > 0 && v.estado === "confirmada" ? "text-amber-700 font-semibold" : ""}`}>{$(v.saldo)}</td>
                    <td className="pl-3"><EstatusVenta estado={v.estado} saldo={v.saldo} cerrada={v.cerrada} /></td>
                  </tr>
                ))}
                {!ventas.length && <tr><td colSpan={5} className="py-3 text-[var(--tenue)]">Sin ventas.</td></tr>}
              </tbody>
            </table>
          )}
          {pestana === "datos" && datos && (
            <div className="grid gap-3 sm:grid-cols-2 max-w-3xl">
              <label>Nombre *<input className="campo" value={datos.nombre} onChange={(e) => set("nombre", e.target.value)} /></label>
              <label>Razón social (como en la constancia)<input className="campo" value={datos.razon_social ?? ""} onChange={(e) => set("razon_social", e.target.value)} /></label>
              <label>RFC<input className="campo" value={datos.rfc ?? ""} onChange={(e) => set("rfc", e.target.value.toUpperCase())} /></label>
              <label>Teléfono<input className="campo" inputMode="tel" value={datos.telefono ?? ""} onChange={(e) => set("telefono", e.target.value)} /></label>
              <label>Correo<input className="campo" type="email" value={datos.correo_facturas ?? ""} onChange={(e) => set("correo_facturas", e.target.value)} /></label>
              <label>Dirección<input className="campo" value={datos.direccion ?? ""} onChange={(e) => set("direccion", e.target.value)} /></label>
              <div className="sm:col-span-2 flex justify-end"><button className="btn-primario" disabled={trabajando || c.es_publico_general} onClick={guardarDatos}>Guardar datos</button></div>
            </div>
          )}
        </div>
      </section>

      {abono && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={() => setAbono(null)}>
          <div role="dialog" aria-label="Abonar a saldo a favor" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-md p-5 text-sm" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">Abonar a saldo a favor</h2>
            <p className="text-[var(--tenue)] mt-1">El cliente deja dinero para usarlo en una compra futura.</p>
            <div className="grid gap-3 sm:grid-cols-2 mt-3">
              <label>Importe<input className="campo" inputMode="decimal" autoFocus value={abono.importe} onChange={(e) => setAbono({ ...abono, importe: e.target.value })} /></label>
              <label>Forma de pago
                <select className="campo" value={abono.forma} onChange={(e) => setAbono({ ...abono, forma: e.target.value })}>
                  <option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option>
                  <option value="tarjeta_debito">Tarjeta de débito</option><option value="tarjeta_credito">Tarjeta de crédito</option>
                </select>
              </label>
              <label className="sm:col-span-2">Sucursal donde se recibe (entra en su corte)
                <select className="campo" value={abono.sucursal} onChange={(e) => setAbono({ ...abono, sucursal: e.target.value })}>
                  {sucursales.map((x) => <option key={x.id} value={x.id}>{x.codigo} - {x.nombre}</option>)}
                </select>
              </label>
              <label className="sm:col-span-2">Referencia / nota<input className="campo" value={abono.referencia} onChange={(e) => setAbono({ ...abono, referencia: e.target.value })} /></label>
            </div>
            <div className="flex justify-end gap-3 mt-4">
              <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={() => setAbono(null)}>Cancelar</button>
              <button className="btn-primario" disabled={trabajando || !(Number(abono.importe) > 0)} onClick={guardarAbono}>{trabajando ? "Guardando…" : "Abonar"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
