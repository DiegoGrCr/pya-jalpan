/** Categorías de gasto de una sucursal (texto libre en BD; esta lista alimenta los selectores). */
export const CATEGORIAS_GASTO = [
  "Renta", "Luz y agua", "Sueldos", "Fletes y transporte", "Combustible",
  "Papelería y limpieza", "Mantenimiento", "Pago a proveedor", "Otros",
] as const;

/** Formas en que se puede pagar un gasto (un retiro siempre es efectivo). */
export const FORMAS_GASTO = ["efectivo", "transferencia", "tarjeta_debito", "tarjeta_credito"] as const;
