import { describe, it, expect } from "vitest";
import { aBase, unidadesNecesarias, cantidadValida, equivalencia, calcularPartida } from "../../src/lib/unidades";

const caja = { id: "c", nombre: "CAJA", factor: "1.44", es_base: false };
const pieza = { id: "p", nombre: "PIEZA", factor: "0.023816", es_base: false };
const m2 = { id: "m", nombre: "M2", factor: "1", es_base: true };

describe("unidades", () => {
  it("10 m² con caja de 1.44 m² -> 7 cajas = 10.08 m²", () => {
    const r = unidadesNecesarias(10, caja, false);
    expect(r.unidades.toString()).toBe("7");
    expect(r.base.toFixed(2)).toBe("10.08");
  });
  it("cantidad exacta no agrega una caja de más", () => {
    expect(unidadesNecesarias("4.32", caja, false).unidades.toString()).toBe("3");
  });
  it("3 cajas + 2.5 m² + 4 piezas de 0.36 = 8.26 m² sin error de redondeo", () => {
    const total = aBase(3, "1.44").plus(aBase("2.5", 1)).plus(aBase(4, "0.36"));
    expect(total.toFixed(6)).toBe("8.260000");
  });
  it("42 piezas de 0.023816 m² = 1.000272 m² (por eso 6 decimales)", () => {
    expect(aBase(42, pieza.factor).toFixed(6)).toBe("1.000272");
  });
  it("solo unidades completas rechaza fracciones", () => {
    expect(cantidadValida("6.5", false)).toBe(false);
    expect(cantidadValida(7, false)).toBe(true);
    expect(cantidadValida("2.5", true)).toBe(true);
  });
  it("muestra la equivalencia en unidad base", () => {
    expect(equivalencia(3, caja, "M2")).toBe("3 CAJA = 4.32 M2");
    expect(equivalencia("2.5", m2, "M2")).toBe("2.5 M2");
  });
  it("calcula importes igual que la BD", () => {
    const r = calcularPartida(3, "360", 0, "0.16", 0, false);
    expect([r.subtotal, r.iva, r.total].map((x) => x.toFixed(2))).toEqual(["1080.00", "172.80", "1252.80"]);
    const inc = calcularPartida(1, "116", 0, "0.16", 0, true);
    expect([inc.subtotal, inc.iva, inc.total].map((x) => x.toFixed(2))).toEqual(["100.00", "16.00", "116.00"]);
  });
});
