"use client";
/**
 * Registrar un pago de un cliente: se elige el cliente (o viene dado), sus notas con saldo (todas marcadas,
 * de la más antigua a la más nueva), el importe y la forma de pago. El importe se reparte de la más antigua
 * a la más nueva (registrar_pago_cliente, 0055).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { FORMAS_PAGO } from "@/lib/documentoVenta";

interface Nota { id: string; serie: string; folio: number; fecha: string; vencimiento: string | null; saldo: string; sucursales: { codigo: string } | null }
const FORMAS = ["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito"] as const;
const $ = (n: number) => `$${fmtImporte(n)}`;
const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" });
const corta = (d: string) => d.slice(0, 10).split("-").reverse().join("/");

export default function DialogoPagoCliente({ cliente: inicial, onCerrar, onListo }: {
  cliente?: { id: string; nombre: string } | null; onCerrar: () => void; onListo: (texto: string) => void;
}) {
  const [cliente, setCliente] = useState(inicial ?? null);
  const [texto, setTexto] = useState("");
  const [lista, setLista] = useState<{ id: string; nombre: string; razon_social: string | null }[]>([]);
  const [notas, setNotas] = useState<Nota[] | null>(null);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [importe, setImporte] = useState("");
  const [forma, setForma] = useState<string>("efectivo");
  const [referencia, setReferencia] = useState("");
  const [clave] = useState(() => crypto.randomUUID());
  const [trabajando, setTrabajando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (cliente || t.length < 2) { setLista([]); return; }
    const h = setTimeout(async () => {
      const { data } = await supabase().from("clientes").select("id, nombre, razon_social").eq("es_publico_general", false)
        .or(`nombre.ilike.%${t}%,razon_social.ilike.%${t}%,rfc.ilike.%${t}%,telefono.ilike.%${t}%`).order("nombre").limit(8);
      setLista((data ?? []) as { id: string; nombre: string; razon_social: string | null }[]);
    }, 200);
    return () => clearTimeout(h);
  }, [texto, cliente]);

  useEffect(() => {
    if (!cliente) { setNotas(null); return; }
    (async () => {
      const { data, error: e } = await supabase().from("ventas").select("id, serie, folio, fecha, vencimiento, saldo, sucursales(codigo)")
        .eq("cliente_id", cliente.id).eq("estado", "confirmada").gt("saldo", 0).limit(500);
      if (e) { setError(mensajeError(e)); return; }
      const ns = ((data ?? []) as unknown as Nota[]).sort((a, b) => (a.vencimiento ?? a.fecha.slice(0, 10)).localeCompare(b.vencimiento ?? b.fecha.slice(0, 10)) || a.fecha.localeCompare(b.fecha));
      setNotas(ns); setMarcadas(new Set(ns.map((n) => n.id)));
    })();
  }, [cliente]);

  const elegidas = useMemo(() => (notas ?? []).filter((n) => marcadas.has(n.id)), [notas, marcadas]);
  const deuda = elegidas.reduce((a, n) => a + Number(n.saldo), 0);
  const imp = Number(importe) || 0;
  // Cómo se reparte (de la más antigua a la más nueva)
  const reparto = useMemo(() => {
    let resta = imp; const m = new Map<string, number>();
    for (const n of elegidas) { if (resta <= 0) break; const a = Math.min(Number(n.saldo), resta); m.set(n.id, Math.round(a * 100) / 100); resta -= a; }
    return m;
  }, [elegidas, imp]);

  const guardar = async () => {
    if (!cliente) return;
    setTrabajando(true); setError(null);
    try {
      const { data, error: e } = await supabase().rpc("registrar_pago_cliente", { p: { idempotency_key: clave, cliente_id: cliente.id, forma, importe: imp,
        referencia: referencia || null, ventas: elegidas.map((n) => n.id) } });
      if (e) {
        if (/registrar_pago_cliente/.test(e.message)) throw new Error("Falta ejecutar la migración 20261123000055_pago_cliente.sql en Supabase.");
        throw e;
      }
      const ap = ((data as { aplicado: { serie: string; folio: number; importe: number }[] }).aplicado ?? []);
      onListo(`Pago de ${$(imp)} de ${cliente.nombre} aplicado a ${ap.map((x) => `${x.serie} ${x.folio}`).join(", ")}.`);
    } catch (err) { setError(mensajeError(err)); } finally { setTrabajando(false); }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-3" onClick={onCerrar}>
      <div role="dialog" aria-label="Registrar pago de cliente" className="bg-[var(--panel)] rounded-md shadow-lg w-full max-w-2xl p-5 text-sm max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">Registrar pago de cliente</h2>
        {!cliente ? (
          <div className="mt-3">
            <input className="campo" autoFocus placeholder="Buscar cliente por nombre, RFC o teléfono…" value={texto} onChange={(e) => setTexto(e.target.value)} />
            {lista.length > 0 && (
              <ul className="border border-[var(--borde)] rounded mt-1 max-h-56 overflow-auto">
                {lista.map((c) => <li key={c.id}><button className="w-full text-left px-2 py-1.5 hover:bg-[var(--resalte)]"
                  onClick={() => setCliente({ id: c.id, nombre: c.razon_social || c.nombre })}>{c.razon_social || c.nombre}</button></li>)}
              </ul>
            )}
          </div>
        ) : (<>
          <div className="mt-2 flex justify-between items-center gap-2">
            <span>Cliente: <b>{cliente.nombre}</b></span>
            {!inicial && <button className="underline text-xs" onClick={() => { setCliente(null); setNotas(null); setImporte(""); }}>Cambiar</button>}
          </div>
          {notas === null ? <p className="mt-3 text-[var(--tenue)]">Cargando notas…</p> : !notas.length ? <p className="mt-3 text-[var(--tenue)]">Este cliente no debe nada.</p> : (<>
            <table className="w-full mt-3">
              <thead style={{ color: "var(--acento)" }}><tr className="text-left border-b border-[var(--borde)]">
                <th className="py-1 w-6"><input type="checkbox" aria-label="Todas" checked={marcadas.size === notas.length}
                  onChange={(e) => setMarcadas(e.target.checked ? new Set(notas.map((n) => n.id)) : new Set())} /></th>
                <th className="font-normal">Nota</th><th className="font-normal">Fecha</th><th className="font-normal">Vence</th>
                <th className="font-normal text-right">Saldo</th><th className="font-normal text-right">Se aplica</th></tr></thead>
              <tbody>
                {notas.map((n) => {
                  const vencida = n.vencimiento && n.vencimiento < hoy();
                  return (
                    <tr key={n.id} className="border-b border-[var(--borde)]">
                      <td className="py-1"><input type="checkbox" checked={marcadas.has(n.id)} aria-label={`${n.serie} ${n.folio}`}
                        onChange={(e) => { const m = new Set(marcadas); if (e.target.checked) m.add(n.id); else m.delete(n.id); setMarcadas(m); }} /></td>
                      <td>{n.serie} {n.folio} <span className="text-xs text-[var(--tenue)]">{n.sucursales?.codigo}</span></td>
                      <td>{corta(n.fecha)}</td>
                      <td className={vencida ? "text-[var(--peligro)] font-semibold" : ""}>{n.vencimiento ? corta(n.vencimiento) : "—"}</td>
                      <td className="text-right">{$(Number(n.saldo))}</td>
                      <td className="text-right text-emerald-700">{reparto.get(n.id) ? $(reparto.get(n.id)!) : ""}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="grid gap-3 sm:grid-cols-3 mt-3">
              <label>Importe
                <input className="campo" inputMode="decimal" placeholder={fmtImporte(deuda)} value={importe} onChange={(e) => setImporte(e.target.value)} />
                <button className="text-xs underline" onClick={() => setImporte(deuda.toFixed(2))}>Pagar todo ({$(deuda)})</button>
              </label>
              <label>Forma de pago
                <select className="campo" value={forma} onChange={(e) => setForma(e.target.value)}>{FORMAS.map((f) => <option key={f} value={f}>{FORMAS_PAGO[f]}</option>)}</select>
              </label>
              <label>Referencia<input className="campo" placeholder="Opcional" value={referencia} onChange={(e) => setReferencia(e.target.value)} /></label>
            </div>
            <p className="text-xs text-[var(--tenue)] mt-2">Se aplica de la nota más antigua a la más nueva. Entra al corte de caja de hoy de la sucursal de cada nota.</p>
            {imp > deuda + 0.004 && <p className="text-xs text-[var(--peligro)] mt-1">El importe es mayor a lo que debe en las notas marcadas ({$(deuda)}).</p>}
          </>)}
        </>)}
        {error && <div role="alert" className="mt-3 rounded px-3 py-2 bg-amber-100 text-amber-900">{error}</div>}
        <div className="flex justify-end gap-3 mt-4">
          <button className="px-4 py-2 rounded border border-[var(--borde)]" onClick={onCerrar}>Cerrar</button>
          <button className="btn-primario" disabled={trabajando || !cliente || !elegidas.length || !(imp > 0) || imp > deuda + 0.004} onClick={guardar}>
            {trabajando ? "Guardando…" : "Registrar pago"}</button>
        </div>
      </div>
    </div>
  );
}
