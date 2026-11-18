"use client";
/**
 * Gráfica de barras de una sola serie (un solo color, un solo eje), con cuadrícula tenue,
 * barras delgadas con punta redondeada y tooltip al pasar el puntero.
 */
import { useState } from "react";

export interface Barra { etiqueta: string; valor: number; detalle?: string }

const W = 720, H = 240, M = { izq: 56, der: 12, arr: 12, aba: 28 };
const compacto = (n: number) => Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${Math.round(n / 1e3)}K` : `${Math.round(n)}`;

/** Paso "bonito" para el eje: 1, 2 o 5 × 10^n */
function escala(max: number) {
  if (max <= 0) return { tope: 1, paso: 1 };
  const bruto = max / 4, p = 10 ** Math.floor(Math.log10(bruto)), r = bruto / p;
  const paso = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
  return { tope: Math.ceil(max / paso) * paso, paso };
}

export default function GraficaBarras({ datos, formato, color = "var(--acento)", alto = H, titulo }: {
  datos: Barra[]; formato: (n: number) => string; color?: string; alto?: number; titulo: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...datos.map((d) => d.valor));
  const { tope, paso } = escala(max);
  const ancho = W - M.izq - M.der, altoP = alto - M.arr - M.aba;
  const banda = ancho / Math.max(datos.length, 1);
  const barra = Math.max(4, Math.min(36, banda - 6));
  const y = (v: number) => M.arr + altoP - (Math.max(v, 0) / tope) * altoP;
  const marcas = Array.from({ length: Math.round(tope / paso) + 1 }, (_, i) => i * paso);
  const cadaEtiqueta = Math.ceil(datos.length / 12);   // no amontonar etiquetas del eje X

  return (
    <div className="relative w-full" role="img" aria-label={`${titulo}: ${datos.map((d) => `${d.etiqueta} ${formato(d.valor)}`).join(", ")}`}>
      <svg viewBox={`0 0 ${W} ${alto}`} className="w-full h-auto" onMouseLeave={() => setHover(null)}>
        {marcas.map((m) => (
          <g key={m}>
            <line x1={M.izq} x2={W - M.der} y1={y(m)} y2={y(m)} stroke="var(--borde)" strokeWidth={m === 0 ? 1.5 : 1} />
            <text x={M.izq - 8} y={y(m) + 4} textAnchor="end" fontSize="11" fill="var(--tenue)">{compacto(m)}</text>
          </g>
        ))}
        {datos.map((d, i) => {
          const x = M.izq + i * banda + (banda - barra) / 2, top = y(d.valor), h = Math.max(0, M.arr + altoP - top), r = Math.min(4, barra / 2, h);
          return (
            <g key={d.etiqueta + i} onMouseEnter={() => setHover(i)}>
              {/* zona de contacto más grande que la barra */}
              <rect x={M.izq + i * banda} y={M.arr} width={banda} height={altoP} fill="transparent" />
              {h > 0 && (
                <path d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barra - r} Q${x + barra},${top} ${x + barra},${top + r} V${top + h} Z`}
                  fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />
              )}
              {i % cadaEtiqueta === 0 && (
                <text x={M.izq + i * banda + banda / 2} y={alto - 8} textAnchor="middle" fontSize="11" fill="var(--tenue)">{d.etiqueta}</text>
              )}
            </g>
          );
        })}
      </svg>
      {hover !== null && datos[hover] && (
        <div className="absolute pointer-events-none rounded border border-[var(--borde)] bg-[var(--panel)] shadow px-2 py-1 text-xs"
          style={{ left: `${((M.izq + hover * banda + banda / 2) / W) * 100}%`, top: 0, transform: "translateX(-50%)" }}>
          <div className="font-semibold">{datos[hover].etiqueta}</div>
          <div>{formato(datos[hover].valor)}</div>
          {datos[hover].detalle && <div className="text-[var(--tenue)]">{datos[hover].detalle}</div>}
        </div>
      )}
    </div>
  );
}
