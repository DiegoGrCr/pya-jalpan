/** Lectura de la hoja de inventario (datos ficticios). */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { extraerFilas, idDeHoja } from "@/lib/hojaInventario";

describe("hoja de inventario", () => {
  it("lee pestañas de pisos (cajas + sueltas) y de otros (cantidad); omite las que no sirven", () => {
    const wb = new ExcelJS.Workbook();
    const a = wb.addWorksheet("Marca A");
    a.addRow(["FORMATO", "SKU", "DESCRIPCIÓN", "PIEZAS X CAJA", "M² X CAJA", "CAJAS EN EXISTENCIA", "PIEZAS SUELTAS"]);
    a.addRow(["60x60", "abc-001", "Piso ejemplo", 4, 1.44, 5, null]);
    a.addRow(["", "ABC-002", "Otro", 4, 1.44, { formula: "2+1", result: 3 }, 2]);
    a.addRow(["", "", "fila vacía", "", "", "", ""]);
    const b = wb.addWorksheet("Adhesivos");
    b.addRow(["CATEGORÍA", "MARCA", "SKU", "DESCRIPCIÓN", "CANTIDAD", "PRECIO"]);
    b.addRow(["Adhesivo", "X", "ADE-001", "Adhesivo ejemplo", 26, 249]);
    wb.addWorksheet("Notas").addRow(["Lo que sea"]);
    const { filas, avisos } = extraerFilas(wb);
    expect(filas).toEqual([
      { sku: "ABC-001", cajas: 5, sueltas: 0, hoja: "Marca A", fila: 2 },
      { sku: "ABC-002", cajas: 3, sueltas: 2, hoja: "Marca A", fila: 3 },
      { sku: "ADE-001", cantidad: 26, hoja: "Adhesivos", fila: 2 },
    ]);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/Notas/);
  });
  it("saca el identificador del enlace", () => {
    expect(idDeHoja("https://docs.google.com/spreadsheets/d/AbC_123-x/edit?gid=1#gid=1")).toBe("AbC_123-x");
    expect(idDeHoja("https://otro.com/x")).toBeNull();
  });
});
