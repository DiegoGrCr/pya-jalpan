/**
 * Decoración de temporada para la remisión y la cotización impresas (PDF tamaño carta).
 * Se dibuja con figuras vectoriales propias (sin imágenes) en la franja superior, antes del encabezado,
 * y un saludo en el pie. Se activa sola según la fecha y se puede desactivar en Configuración › Empresa.
 */
type Doc = import("jspdf").jsPDF;
type RGB = [number, number, number];

export type Temporada = "navidad" | "amor" | "madres" | "patrias" | "muertos";

/** Fechas (MM-DD, hora del centro de México); Navidad cruza el año nuevo */
export const TEMPORADAS: Record<Temporada, { nombre: string; desde: string; hasta: string; saludo: string; color: RGB }> = {
  navidad: { nombre: "Navidad y Año Nuevo", desde: "12-01", hasta: "01-06", saludo: "¡Felices fiestas y próspero año nuevo!", color: [178, 34, 34] },
  amor:    { nombre: "Día del Amor y la Amistad", desde: "02-07", hasta: "02-14", saludo: "¡Feliz día del amor y la amistad!", color: [214, 51, 108] },
  madres:  { nombre: "Día de las Madres", desde: "05-01", hasta: "05-10", saludo: "¡Feliz día a todas las mamás!", color: [190, 70, 140] },
  patrias: { nombre: "Fiestas Patrias", desde: "09-01", hasta: "09-16", saludo: "¡Viva México!", color: [0, 104, 71] },
  muertos: { nombre: "Día de Muertos", desde: "10-25", hasta: "11-02", saludo: "Celebrando nuestras tradiciones · Día de Muertos", color: [214, 110, 0] },
};

/** Temporada vigente en una fecha (o null) */
export function temporadaDe(fecha: Date = new Date()): Temporada | null {
  const md = fecha.toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }).slice(5);
  for (const [t, d] of Object.entries(TEMPORADAS) as [Temporada, (typeof TEMPORADAS)[Temporada]][]) {
    const dentro = d.desde <= d.hasta ? md >= d.desde && md <= d.hasta : md >= d.desde || md <= d.hasta;
    if (dentro) return t;
  }
  return null;
}

const relleno = (doc: Doc, c: RGB) => doc.setFillColor(c[0], c[1], c[2]);
const trazo = (doc: Doc, c: RGB) => doc.setDrawColor(c[0], c[1], c[2]);

/** Línea colgante (catenaria aproximada) entre x1 y x2 */
function colgante(doc: Doc, x1: number, x2: number, y: number, caida: number, pasos = 14): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= pasos; i++) { const t = i / pasos; pts.push([x1 + (x2 - x1) * t, y + caida * Math.sin(Math.PI * t)]); }
  for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return pts;
}

function corazon(doc: Doc, x: number, y: number, s: number, c: RGB) {
  relleno(doc, c);
  doc.circle(x - s * 0.5, y, s * 0.56, "F").circle(x + s * 0.5, y, s * 0.56, "F");
  doc.triangle(x - s * 1.04, y + s * 0.18, x + s * 1.04, y + s * 0.18, x, y + s * 1.5, "F");
}

function flor(doc: Doc, x: number, y: number, r: number, c: RGB) {
  relleno(doc, c);
  for (let k = 0; k < 5; k++) { const a = (k * 2 * Math.PI) / 5 - Math.PI / 2; doc.circle(x + Math.cos(a) * r, y + Math.sin(a) * r, r * 0.85, "F"); }
  relleno(doc, [250, 200, 60]); doc.circle(x, y, r * 0.65, "F");
}

/** Dibuja la franja superior (y < 11 mm) de la temporada */
function franja(doc: Doc, t: Temporada, W: number) {
  doc.saveGraphicsState();
  if (t === "navidad") {
    // Guirnalda verde con esferas de colores y moños con hojas de acebo en los ganchos
    const esferas: RGB[] = [[200, 30, 45], [218, 165, 32], [30, 90, 170], [30, 130, 70]];
    const tramo = 34; let k = 0;
    for (let x = 0; x < W; x += tramo) {
      trazo(doc, [22, 100, 50]); doc.setLineWidth(1.1);
      const pts = colgante(doc, x, Math.min(x + tramo, W + 2), 1.6, 4.2);
      for (const f of [0.25, 0.5, 0.75]) {
        const [px, py] = pts[Math.round(f * (pts.length - 1))];
        relleno(doc, [170, 170, 170]); doc.rect(px - 0.55, py + 0.4, 1.1, 0.9, "F");
        relleno(doc, esferas[k++ % esferas.length]); doc.circle(px, py + 2.6, 1.35, "F");
        relleno(doc, [255, 255, 255]); doc.circle(px - 0.45, py + 2.1, 0.32, "F");   // brillo
      }
      // acebo en el gancho
      relleno(doc, [22, 110, 55]);
      doc.triangle(x - 2.6, 1.4, x, 0.6, x - 0.4, 2.6, "F").triangle(x + 2.6, 1.4, x, 0.6, x + 0.4, 2.6, "F");
      relleno(doc, [200, 25, 40]); doc.circle(x - 0.5, 2.1, 0.55, "F").circle(x + 0.5, 2.1, 0.55, "F").circle(x, 2.8, 0.55, "F");
    }
  } else if (t === "muertos") {
    // Papel picado de colores colgando de un hilo
    const colores: RGB[] = [[228, 0, 124], [255, 140, 0], [123, 44, 191], [0, 160, 80], [255, 190, 0], [0, 140, 210]];
    trazo(doc, [120, 120, 120]); doc.setLineWidth(0.25).line(0, 1.4, W, 1.4);
    const ancho = 13, sep = 1.6; let k = 0;
    const n = Math.floor((W + sep) / (ancho + sep)), inicio = (W - (n * ancho + (n - 1) * sep)) / 2;   // centrado
    for (let x = inicio; x + ancho <= W; x += ancho + sep) {
      const c = colores[k++ % colores.length];
      relleno(doc, c); doc.rect(x, 1.4, ancho, 6.4, "F");
      const dientes = 6;   // orilla inferior en picos
      for (let i = 0; i < dientes; i++) doc.triangle(x + (i * ancho) / dientes, 7.8, x + ((i + 1) * ancho) / dientes, 7.8, x + ((i + 0.5) * ancho) / dientes, 9.6, "F");
      // calados en blanco: flor central, rombos y fila de puntos
      relleno(doc, [255, 255, 255]);
      const cx = x + ancho / 2, cy = 4.9;
      doc.circle(cx, cy, 0.9, "F");
      for (let a = 0; a < 4; a++) { const ang = (a * Math.PI) / 2; doc.circle(cx + Math.cos(ang) * 1.8, cy + Math.sin(ang) * 1.8, 0.55, "F"); }
      for (const dx of [-4.6, 4.6]) doc.triangle(cx + dx, cy - 1.2, cx + dx - 0.8, cy, cx + dx + 0.8, cy, "F").triangle(cx + dx, cy + 1.2, cx + dx - 0.8, cy, cx + dx + 0.8, cy, "F");
      for (let i = 1; i < 6; i++) doc.circle(x + (i * ancho) / 6, 2.4, 0.25, "F");
    }
  } else if (t === "patrias") {
    // Banderines verde, blanco y rojo
    const colores: RGB[] = [[0, 104, 71], [255, 255, 255], [206, 17, 38]];
    trazo(doc, [110, 110, 110]); doc.setLineWidth(0.25);
    const tramo = 46;
    for (let x0 = 0; x0 < W; x0 += tramo) colgante(doc, x0, Math.min(x0 + tramo, W + 2), 1.2, 2.2);
    const ancho = 7.4; let k = 0;
    for (let x = 1; x + ancho <= W; x += ancho + 0.8) {
      const t0 = ((x % tramo) + ancho / 2) / tramo;
      const y = 1.2 + 2.2 * Math.sin(Math.PI * Math.min(Math.max(t0, 0), 1));
      const c = colores[k++ % 3];
      relleno(doc, c); doc.triangle(x, y, x + ancho, y, x + ancho / 2, y + 6.8, "F");
      if (c[0] === 255) { trazo(doc, [180, 180, 180]); doc.setLineWidth(0.2).triangle(x, y, x + ancho, y, x + ancho / 2, y + 6.8, "S"); }
    }
  } else if (t === "amor") {
    // Corazones de distintos tamaños y tonos
    const tonos: RGB[] = [[214, 40, 80], [240, 110, 150], [190, 20, 60], [250, 160, 185]];
    let k = 0;
    for (let x = 4; x < W - 2; x += 9.5) {
      const s = [1.6, 1.1, 1.9, 1.3][k % 4], y = [3.2, 5.6, 2.6, 4.8][k % 4];
      corazon(doc, x, y, s, tonos[k++ % tonos.length]);
    }
  } else if (t === "madres") {
    // Enredadera con flores
    trazo(doc, [70, 140, 70]); doc.setLineWidth(0.5);
    const pts: [number, number][] = [];
    for (let x = 0; x <= W; x += 1.5) pts.push([x, 5 + 1.6 * Math.sin(x / 7)]);
    for (let i = 1; i < pts.length; i++) doc.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    const tonos: RGB[] = [[236, 120, 170], [186, 120, 210], [245, 150, 120], [220, 80, 140]];
    let k = 0;
    for (let x = 6; x < W - 3; x += 15) {
      const y = 5 + 1.6 * Math.sin(x / 7);
      relleno(doc, [80, 160, 80]); doc.ellipse(x + 3.2, y + 0.9, 1.6, 0.7, "F").ellipse(x - 3.2, y - 0.9, 1.6, 0.7, "F");
      flor(doc, x, y, k % 2 ? 1.25 : 1.6, tonos[k++ % tonos.length]);
    }
  }
  doc.restoreGraphicsState();
  doc.setLineWidth(0.2).setDrawColor(0);
}

/** Decora la página actual: franja superior y, si hay espacio, el saludo en el pie */
export function decorarPagina(doc: Doc, t: Temporada, W: number, H: number, conSaludo: boolean) {
  franja(doc, t, W);
  if (conSaludo) {
    const c = TEMPORADAS[t].color;
    doc.setFont("helvetica", "bolditalic").setFontSize(8).setTextColor(c[0], c[1], c[2]).text(TEMPORADAS[t].saludo, W / 2, H - 7, { align: "center" });
    doc.setFont("helvetica", "normal");
  }
}
