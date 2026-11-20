/**
 * Esqueletos de carga: bloques grises que pulsan con la forma de lo que va a aparecer, para que al
 * cambiar de pantalla o mientras llegan los datos se note que el sistema está trabajando.
 * Se usan en los loading.tsx (aparecen al instante al dar clic) y dentro de las páginas.
 */
const base = "animate-pulse rounded bg-[var(--borde)]";

export function Bloque({ className = "" }: { className?: string }) {
  return <div className={`${base} ${className}`} aria-hidden />;
}

/** Texto para lectores de pantalla */
const Leyenda = () => <span className="sr-only">Cargando…</span>;

/** Renglones de tabla (dentro de un <tbody>) */
export function EsqueletoFilas({ columnas = 6, filas = 8 }: { columnas?: number; filas?: number }) {
  return (
    <>
      {Array.from({ length: filas }, (_, r) => (
        <tr key={r} className="border-b border-[var(--borde)]" aria-hidden>
          {Array.from({ length: columnas }, (_, c) => (
            <td key={c} className="p-2"><Bloque className={`h-4 ${c === 0 ? "w-20" : c % 3 === 1 ? "w-40" : "w-24"} ${r % 2 ? "opacity-70" : ""}`} /></td>
          ))}
        </tr>
      ))}
    </>
  );
}

/** Tabla completa (encabezado + renglones) para lugares sin <table> */
export function EsqueletoTabla({ columnas = 6, filas = 8 }: { columnas?: number; filas?: number }) {
  return (
    <div role="status" className="w-full overflow-hidden">
      <Leyenda />
      <table className="w-full text-sm">
        <thead><tr className="border-b border-[var(--borde)]">
          {Array.from({ length: columnas }, (_, c) => <th key={c} className="p-2"><Bloque className="h-3 w-16" /></th>)}
        </tr></thead>
        <tbody><EsqueletoFilas columnas={columnas} filas={filas} /></tbody>
      </table>
    </div>
  );
}

/** Pantalla de lista: título, filtros y tabla */
export function EsqueletoLista({ columnas = 7 }: { columnas?: number }) {
  return (
    <div role="status" className="p-3 sm:p-5 flex flex-col gap-4">
      <Leyenda />
      <div className="flex items-center justify-between gap-3">
        <Bloque className="h-7 w-56" /><Bloque className="h-9 w-36" />
      </div>
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="flex flex-col gap-1.5"><Bloque className="h-3 w-16" /><Bloque className="h-9 w-full" /></div>)}
      </div>
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-2">
        <EsqueletoTabla columnas={columnas} filas={10} />
      </div>
    </div>
  );
}

/** Detalle de un documento (venta, cotización, cliente, recepción): título, datos y renglones */
export function EsqueletoFicha() {
  return (
    <div role="status" className="p-3 sm:p-5 flex flex-col gap-4">
      <Leyenda />
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Bloque className="h-7 w-64" />
        <div className="flex gap-2"><Bloque className="h-9 w-24" /><Bloque className="h-9 w-24" /><Bloque className="h-9 w-28" /></div>
      </div>
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => <div key={i} className="flex flex-col gap-1.5"><Bloque className="h-3 w-20" /><Bloque className="h-4 w-44" /></div>)}
      </div>
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-2">
        <EsqueletoTabla columnas={6} filas={5} />
      </div>
      <div className="self-end flex flex-col gap-2 items-end"><Bloque className="h-4 w-40" /><Bloque className="h-4 w-32" /><Bloque className="h-6 w-48" /></div>
    </div>
  );
}

/** Formulario de captura (venta, recepción, producto) */
export function EsqueletoFormulario() {
  return (
    <div role="status" className="p-3 sm:p-5 flex flex-col gap-4">
      <Leyenda />
      <Bloque className="h-7 w-64" />
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <div key={i} className="flex flex-col gap-1.5"><Bloque className="h-3 w-24" /><Bloque className="h-9 w-full" /></div>)}
      </div>
      <div className="bg-[var(--panel)] rounded-md border border-[var(--borde)] p-4 flex flex-col gap-3">
        <Bloque className="h-9 w-full max-w-xl" />
        <EsqueletoTabla columnas={6} filas={3} />
      </div>
      <div className="self-end"><Bloque className="h-10 w-44" /></div>
    </div>
  );
}

/** Tablero de inicio: tarjetas y gráficas */
export function EsqueletoTablero() {
  return (
    <div role="status" className="p-4 flex flex-col gap-5">
      <Leyenda />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => <div key={i} className="rounded border border-[var(--borde)] p-3 flex flex-col gap-2"><Bloque className="h-3 w-24" /><Bloque className="h-7 w-32" /></div>)}
      </div>
      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="rounded border border-[var(--borde)] p-3 flex items-end gap-2 h-56">
          {Array.from({ length: 14 }, (_, i) => <div key={i} className="flex-1 h-full flex items-end"><div className={`${base} w-full`} style={{ height: `${30 + ((i * 37) % 60)}%` }} /></div>)}
        </div>
        <div className="flex flex-col gap-2">{Array.from({ length: 7 }, (_, i) => <Bloque key={i} className="h-5 w-full" />)}</div>
      </div>
    </div>
  );
}
