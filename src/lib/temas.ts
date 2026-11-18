/**
 * Colores de interfaz por usuario. "verde" (o vacío) es el normal del sistema (globals.css);
 * los demás reemplazan las variables CSS al iniciar sesión.
 */
export const TEMAS: Record<string, { nombre: string; vars: Record<string, string> }> = {
  verde: { nombre: "Verde azulado (normal)", vars: {} },
  morado: { nombre: "Morado", vars: {
    "--fondo": "#f3f1f8", "--borde": "#ddd6ea", "--resalte": "#f1eafe", "--acento": "#6d28d9",
    "--menu": "#251c42", "--menu-texto": "#e4dcf7", "--menu-activo": "#34285a", "--barra": "#1e1736" } },
  terracota: { nombre: "Terracota", vars: {
    "--fondo": "#f6f1ee", "--borde": "#e2d6cf", "--resalte": "#fbeee6", "--acento": "#b4532a",
    "--menu": "#33211a", "--menu-texto": "#f0e2da", "--menu-activo": "#4a3026", "--barra": "#2a1a14" } },
  grafito: { nombre: "Grafito y ámbar", vars: {
    "--fondo": "#f1f2f4", "--borde": "#d9dce1", "--resalte": "#fdf3e3", "--acento": "#b45309",
    "--menu": "#23272e", "--menu-texto": "#e2e5ea", "--menu-activo": "#323844", "--barra": "#1c1f24" } },
};

/** Aplica el tema al documento (o lo quita si es el normal). */
export function aplicarTema(tema: string | null | undefined) {
  const raiz = document.documentElement;
  for (const t of Object.values(TEMAS)) for (const k of Object.keys(t.vars)) raiz.style.removeProperty(k);
  for (const [k, v] of Object.entries(TEMAS[tema ?? ""]?.vars ?? {})) raiz.style.setProperty(k, v);
}
