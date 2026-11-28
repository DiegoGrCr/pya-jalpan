/**
 * Marca del sistema: «Triedro» (figura de tres planos que se unen en un vértice, como el logotipo: tres
 * módulos —inventario, ventas y finanzas— unidos en un solo sistema). Es independiente de la empresa que lo
 * usa: el nombre y los logos de la empresa se configuran en Configuración › Empresa.
 * Se puede cambiar sin tocar el código con NEXT_PUBLIC_NOMBRE_SISTEMA (Vercel).
 */
export const NOMBRE_SISTEMA = process.env.NEXT_PUBLIC_NOMBRE_SISTEMA || "Triedro";
export const DESCRIPCION_SISTEMA = "Inventarios, ventas, punto de venta, finanzas y facturación";
export const COLOR_TEMA = "#0b2f2c";
