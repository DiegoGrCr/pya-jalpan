/**
 * Conversión de unidades de venta y cálculos de partida en el cliente.
 * Usa aritmética decimal exacta (decimal.js). El servidor (confirmar_venta) es la
 * fuente de verdad; esto replica sus reglas para mostrar totales y equivalencias.
 */
import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export interface UnidadVenta {
  id: string;
  nombre: string;      // 'CAJA', 'PIEZA', 'M2'
  factor: string;      // unidades base por unidad de venta, como texto numérico
  es_base: boolean;
  precio?: string | null;
}

export interface ProductoVenta {
  id: string;
  sku: string;
  nombre: string;
  unidad_base: string;
  permite_fraccion: boolean;
  iva_tasa: string;
  ieps_tasa: string;
  tipo: "producto" | "servicio";
  unidades: UnidadVenta[];
}

const D = (v: Decimal.Value) => new Decimal(v);

/** Cantidad en unidad base, redondeada a 6 decimales como en la BD. */
export function aBase(cantidad: Decimal.Value, factor: Decimal.Value): Decimal {
  return D(cantidad).times(factor).toDecimalPlaces(6);
}

/** Unidades de venta necesarias para cubrir una cantidad en unidad base (redondea hacia arriba). */
export function unidadesNecesarias(
  cantidadBase: Decimal.Value,
  unidad: Pick<UnidadVenta, "factor" | "es_base">,
  permiteFraccion: boolean,
): { unidades: Decimal; base: Decimal } {
  if (permiteFraccion && unidad.es_base) {
    return { unidades: D(cantidadBase), base: D(cantidadBase).toDecimalPlaces(6) };
  }
  const unidades = D(cantidadBase).div(unidad.factor).ceil();
  return { unidades, base: aBase(unidades, unidad.factor) };
}

/** ¿La cantidad es válida para el producto? (entera si solo se venden unidades completas) */
export function cantidadValida(cantidad: Decimal.Value, permiteFraccion: boolean): boolean {
  const c = D(cantidad);
  if (c.lte(0)) return false;
  return permiteFraccion || c.isInteger();
}

/** Formato de cantidad para pantalla: hasta `dec` decimales, sin ceros sobrantes. */
export function fmtCantidad(v: Decimal.Value, dec = 4): string {
  return D(v).toDecimalPlaces(dec).toNumber().toLocaleString("es-MX", { maximumFractionDigits: dec });
}

/** "3 CAJA = 4.32 M2" */
export function equivalencia(cantidad: Decimal.Value, unidad: UnidadVenta, unidadBase: string): string {
  if (unidad.es_base) return `${fmtCantidad(cantidad)} ${unidadBase}`;
  return `${fmtCantidad(cantidad)} ${unidad.nombre} = ${fmtCantidad(aBase(cantidad, unidad.factor))} ${unidadBase}`;
}

export interface ImportesPartida { subtotal: Decimal; ieps: Decimal; iva: Decimal; total: Decimal }

/** Igual que public.calcular_partida en la BD. */
export function calcularPartida(
  cantidad: Decimal.Value, precio: Decimal.Value, descuento: Decimal.Value,
  ivaTasa: Decimal.Value, iepsTasa: Decimal.Value, incluyeImpuestos: boolean,
): ImportesPartida {
  const bruto = D(cantidad).times(precio).toDecimalPlaces(2).minus(descuento || 0);
  if (bruto.lt(0)) throw new Error("El descuento no puede ser mayor al importe");
  if (incluyeImpuestos) {
    const total = bruto;
    const subtotal = bruto.div(D(1).plus(iepsTasa).times(D(1).plus(ivaTasa))).toDecimalPlaces(2);
    const ieps = subtotal.times(iepsTasa).toDecimalPlaces(2);
    return { subtotal, ieps, iva: total.minus(subtotal).minus(ieps), total };
  }
  const subtotal = bruto;
  const ieps = subtotal.times(iepsTasa).toDecimalPlaces(2);
  const iva = subtotal.plus(ieps).times(ivaTasa).toDecimalPlaces(2);
  return { subtotal, ieps, iva, total: subtotal.plus(ieps).plus(iva) };
}

export const mxn = (v: Decimal.Value) =>
  D(v).toNumber().toLocaleString("es-MX", { style: "currency", currency: "MXN" });
