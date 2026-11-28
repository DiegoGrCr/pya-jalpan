/**
 * Marca del sistema (independiente de la empresa que lo usa: el nombre y logos de la empresa
 * se configuran en Configuración › Empresa). El nombre comercial aún no está decidido: se toma de
 * NEXT_PUBLIC_NOMBRE_SISTEMA (Vercel) y, si no está, queda el provisional.
 */
export const NOMBRE_SISTEMA = process.env.NEXT_PUBLIC_NOMBRE_SISTEMA || "[NOMBRE]";
export const DESCRIPCION_SISTEMA = "Inventarios, ventas, punto de venta, finanzas y facturación";
export const COLOR_TEMA = "#0b2f2c";
