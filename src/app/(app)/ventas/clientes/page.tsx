"use client";
/** Ventas › Clientes: lista con lo que deben (ventas con saldo) y su saldo a favor; alta de cliente. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { fmtImporte } from "@/lib/unidades";
import { EsqueletoFilas } from "@/components/Esqueleto";

interface Fila {
  id: string; nombre: string; razon_social: string | null; rfc: string | null; telefono: string | null; correo_facturas: string | null;
  saldo_a_favor: string; por_cobrar: string; ventas_con_saldo: number; ultima_compra: string | null; total_filas: number;
}
const POR_PAGINA = 50;
const RFC_VALIDO = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;

export default function Clientes() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [total, setTotal] = useState(0);
  const [texto, setTexto] = useState("");
  const [filtro, setFiltro] = useState<"" | "debe" | "favor">("");
  const [pagina, setPagina] = useState(0);
  const [cargando, setCargando] = useState(true);
  const [msg, setMsg] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  const [nuevo, setNuevo] = useState<{ nombre: string; rfc: string; telefono: string; correo: string } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const { data, error } = await supabase().rpc("clientes_cartera", { p: { texto, filtro, limite: POR_PAGINA, desplazamiento: pagina * POR_PAGINA } });
      if (error) {
        if (/clientes_cartera/.test(error.message)) throw new Error("Falta ejecutar la migración 20261118000038_cartera_devoluciones.sql en Supabase.");
        throw error;
      }
      const d = (data ?? []) as Fila[];
      setFilas(d); setTotal(d[0]?.total_filas ?? 0);
    } catch (e) { setMsg({ tipo: "error", texto: mensajeError(e) }); } finally { setCargando(false); }
  }, [texto, filtro, pagina]);
  useEffect(() => { const h = setTimeout(cargar, 250); return () => clearTimeout(h); }, [cargar]);
  useEffect(() => { setPagina(0); }, [texto, filtro]);

  const crear = async () => {
    if (!nuevo) return;
    const nombre = nuevo.nombre.trim(), rfc = nuevo.rfc.trim().toUpperCase();
    if (!nombre) { setMsg({ tipo: "error", texto: "Escribe el nombre del cliente." }); return; }
    if (rfc && !RFC_VALIDO.test(rfc)) { setMsg({ tipo: "error", texto: "El RFC no es válido (12 o 13 caracteres)." }); return; }
    const { data, error } = await supabase().from("clientes")
      .insert({ nombre, rfc: rfc || null, telefono: nuevo.telefono.trim() || null, correo_facturas: nuevo.correo.trim() || null }).select("id").single();
    if (error) { setMsg({ tipo: "error", texto: mensajeError(error) }); return; }
    window.location.href = `/ventas/clientes/${(data as { id: string }).id}`;
  };

  const sumaFavor = filas.reduce((s, f) => s + Number(f.saldo_a_favor), 0);
  const sumaDebe = filas.reduce((s, f) => s + Number(f.por_cobrar), 0);

  return (
    <div className="p-3 sm:p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Clientes</h1>
        <button className="btn-primario" onClick={() => setNuevo(nuevo ? null : { nombre: "", rfc: "", telefono: "", correo: "" })}>+ Nuevo cliente</button>
      </div>
      {msg && <div role="alert" className={`rounded px-4 py-2 ${msg.tipo === "ok" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-900"}`}>{msg.texto}</div>}

      {nuevo && (
        <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1.5fr_auto] items-end text-sm">
          <label>Nombre *<input className="campo" autoFocus value={nuevo.nombre} onChange={(e) => setNuevo({ ...nuevo, nombre: e.target.value })} /></label>
          <label>RFC<input className="campo" value={nuevo.rfc} onChange={(e) => setNuevo({ ...nuevo, rfc: e.target.value.toUpperCase() })} /></label>
          <label>Teléfono<input className="campo" inputMode="tel" value={nuevo.telefono} onChange={(e) => setNuevo({ ...nuevo, telefono: e.target.value })} /></label>
          <label>Correo<input className="campo" type="email" value={nuevo.correo} onChange={(e) => setNuevo({ ...nuevo, correo: e.target.value })} /></label>
          <div className="flex gap-3"><button className="underline" onClick={() => setNuevo(null)}>Cancelar</button><button className="btn-primario" onClick={crear}>Dar de alta</button></div>
        </section>
      )}

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-[2fr_1fr] items-end text-sm">
        <label>Buscar<input className="campo" placeholder="Nombre, razón social, RFC o teléfono" value={texto} onChange={(e) => setTexto(e.target.value)} /></label>
        <label>Mostrar
          <select className="campo" value={filtro} onChange={(e) => setFiltro(e.target.value as typeof filtro)}>
            <option value="">Todos</option><option value="debe">Con saldo por cobrar</option><option value="favor">Con saldo a favor</option>
          </select>
        </label>
      </section>

      <section className="bg-[var(--panel)] rounded-md border border-[var(--borde)] overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead style={{ color: "var(--acento)" }}>
            <tr className="text-left border-b border-[var(--borde)]">
              <th className="p-2 font-normal">Cliente</th><th className="pr-3 font-normal">RFC</th><th className="pr-3 font-normal">Teléfono</th>
              <th className="pr-3 font-normal text-right">Por cobrar</th><th className="pr-3 font-normal text-right">Saldo a favor</th><th className="pr-2 font-normal">Última compra</th>
            </tr>
          </thead>
          <tbody>
            {cargando && !filas.length && <EsqueletoFilas columnas={6} />}
            {filas.map((f, i) => (
              <tr key={f.id} className="border-b border-[var(--borde)]" style={{ background: i % 2 ? undefined : "#f7f9fb" }}>
                <td className="p-2"><Link className="underline" href={`/ventas/clientes/${f.id}`}>{f.razon_social || f.nombre}</Link>
                  {f.razon_social && f.razon_social !== f.nombre && <div className="text-xs text-[var(--tenue)]">{f.nombre}</div>}</td>
                <td className="pr-3">{f.rfc ?? ""}</td><td className="pr-3">{f.telefono ?? ""}</td>
                <td className={`pr-3 text-right ${Number(f.por_cobrar) > 0 ? "text-amber-700 font-semibold" : "text-[var(--tenue)]"}`}>
                  {Number(f.por_cobrar) > 0 ? <>${fmtImporte(f.por_cobrar)}<div className="text-xs font-normal">{f.ventas_con_saldo} venta{f.ventas_con_saldo === 1 ? "" : "s"}</div></> : "—"}</td>
                <td className={`pr-3 text-right ${Number(f.saldo_a_favor) > 0 ? "text-emerald-700 font-semibold" : "text-[var(--tenue)]"}`}>{Number(f.saldo_a_favor) > 0 ? `$${fmtImporte(f.saldo_a_favor)}` : "—"}</td>
                <td className="pr-2">{f.ultima_compra ? new Date(f.ultima_compra).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" }) : "—"}</td>
              </tr>
            ))}
            {!cargando && filas.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-[var(--tenue)]">No hay clientes con esos filtros.</td></tr>}
          </tbody>
        </table>
      </section>

      <div className="flex justify-between items-center flex-wrap gap-3 text-sm">
        <span className="text-[var(--tenue)]">{cargando ? "Cargando…" : `${total} cliente${total === 1 ? "" : "s"}`}
          {!cargando && filas.length > 0 && <> · En esta página: por cobrar ${fmtImporte(sumaDebe)} · a favor ${fmtImporte(sumaFavor)}</>}</span>
        {total > POR_PAGINA && (
          <div className="flex gap-3 items-center">
            <button className="underline disabled:opacity-40" disabled={pagina === 0} onClick={() => setPagina((p) => p - 1)}>← Anterior</button>
            <span>Página {pagina + 1} de {Math.ceil(total / POR_PAGINA)}</span>
            <button className="underline disabled:opacity-40" disabled={(pagina + 1) * POR_PAGINA >= total} onClick={() => setPagina((p) => p + 1)}>Siguiente →</button>
          </div>
        )}
      </div>
    </div>
  );
}
