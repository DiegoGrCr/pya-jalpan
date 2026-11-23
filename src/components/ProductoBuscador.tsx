"use client";
/** Buscador de productos (código, nombre o código de barras) para traspasos, ajustes y conteo. Se cierra al dar clic fuera. */
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { nombreConCaja } from "@/lib/unidades";

export interface UnidadSimple { id: string; nombre: string; factor: number; es_base: boolean; orden: number }
export interface ProductoSimple {
  id: string; sku: string; nombre: string; unidad_base: string; permite_fraccion: boolean; tipo: string;
  m2_por_caja: string | null; piezas_por_caja: number | null; formato: string | null; unidades: UnidadSimple[];
}

export default function ProductoBuscador({ onElegir, placeholder = "Agregar producto: código, nombre o código de barras…" }: {
  onElegir: (p: ProductoSimple) => void; placeholder?: string;
}) {
  const [texto, setTexto] = useState("");
  const [res, setRes] = useState<ProductoSimple[]>([]);
  const caja = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = texto.trim().replace(/[%,()]/g, "");
    if (t.length < 2) { setRes([]); return; }
    const h = setTimeout(async () => {
      const consulta = (extra: string) => supabase().from("productos")
        .select(`id, sku, nombre, unidad_base, permite_fraccion, tipo${extra}, unidades_venta(id, nombre, factor, es_base, orden)`)
        .eq("activo", true).eq("tipo", "producto").or(`sku.ilike.%${t}%,nombre.ilike.%${t}%,codigo_barras.eq.${t}`).order("sku").limit(20);
      let { data, error } = await consulta(", m2_por_caja, piezas_por_caja, formato");
      if (error) ({ data, error } = await consulta(""));
      setRes(((data ?? []) as unknown as (Omit<ProductoSimple, "unidades"> & { unidades_venta: UnidadSimple[] })[]).map(({ unidades_venta, ...p }) => ({
        ...p, m2_por_caja: p.m2_por_caja ?? null, piezas_por_caja: p.piezas_por_caja ?? null, formato: p.formato ?? null,
        unidades: [...unidades_venta].map((u) => ({ ...u, factor: Number(u.factor) })).sort((a, b) => a.orden - b.orden) })));
    }, 200);
    return () => clearTimeout(h);
  }, [texto]);

  useEffect(() => {
    if (!res.length) return;
    const fuera = (e: MouseEvent) => { if (caja.current && !caja.current.contains(e.target as Node)) setRes([]); };
    document.addEventListener("mousedown", fuera);
    return () => document.removeEventListener("mousedown", fuera);
  }, [res.length]);

  const elegir = (p: ProductoSimple) => { onElegir(p); setTexto(""); setRes([]); };

  return (
    <div className="relative" ref={caja}>
      <input className="campo" placeholder={placeholder} value={texto} onChange={(e) => setTexto(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && res[0]) { e.preventDefault(); elegir(res[0]); } if (e.key === "Escape") setRes([]); }} />
      {res.length > 0 && (
        <ul className="absolute z-20 w-full bg-[var(--panel)] border border-[var(--borde)] shadow max-h-72 overflow-auto text-sm">
          {res.map((p, i) => (
            <li key={p.id}><button type="button" className="w-full text-left px-3 py-1.5 hover:bg-[var(--resalte)]"
              style={i === 0 ? { background: "var(--acento)", color: "white" } : undefined} onClick={() => elegir(p)}>
              {p.sku} - {nombreConCaja(p.nombre, p.m2_por_caja, p.formato)}</button></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Unidad CAJA y PIEZA de un producto (si tiene ambas), para capturar cajas + piezas */
export function cajaPieza(p: ProductoSimple): { caja: UnidadSimple; pieza: UnidadSimple } | null {
  const caja = p.unidades.find((u) => /^CAJAS?$/i.test(u.nombre.trim()));
  const pieza = p.unidades.find((u) => /^(PIEZAS?|PZAS?|PZ)$/i.test(u.nombre.trim()));
  return caja && pieza && caja.factor > pieza.factor ? { caja, pieza } : null;
}

/** "12 cajas 3 pz" (o "14.4 M2") a partir de una cantidad en unidad base */
export function textoBase(p: ProductoSimple, base: number): string {
  const cp = cajaPieza(p);
  if (!cp) return `${Math.round(base * 1000) / 1000} ${p.unidad_base}`;
  const signo = base < 0 ? "−" : "";
  const piezas = Math.round(Math.abs(base) / cp.pieza.factor);
  const porCaja = Math.round(cp.caja.factor / cp.pieza.factor);
  const cj = Math.floor(piezas / porCaja), pz = piezas - cj * porCaja;
  return signo + ([cj ? `${cj} caja${cj === 1 ? "" : "s"}` : "", pz ? `${pz} pz` : ""].filter(Boolean).join(" ") || "0");
}
