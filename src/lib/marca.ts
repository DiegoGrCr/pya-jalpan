/**
 * Marca del sistema: «Cubo» (como el logotipo: un cubo de tres caras —inventario, ventas y finanzas—
 * que forman un solo sistema). Es independiente de la empresa que lo usa: el nombre y los logos de la
 * empresa se configuran en Configuración › Empresa.
 * Se puede cambiar sin tocar el código con NEXT_PUBLIC_NOMBRE_SISTEMA (Vercel).
 */
export const NOMBRE_SISTEMA = process.env.NEXT_PUBLIC_NOMBRE_SISTEMA || "Cubo";
export const DESCRIPCION_SISTEMA = "Inventarios, ventas, punto de venta, finanzas y facturación";
export const COLOR_TEMA = "#0b2f2c";
