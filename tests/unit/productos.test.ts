/** Plantilla de productos: generar, leer (incluye celdas combinadas como en la hoja actual) y cálculos. */
import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { areaFormato, generarPlantilla, leerExcel, preciosPiso, prefijoSku } from "@/lib/productos";

const archivo = async (b: Blob | ArrayBuffer, nombre = "x.xlsx") =>
  new File([b instanceof Blob ? await b.arrayBuffer() : b], nombre);

describe("Plantilla de productos", () => {
  it("la plantilla generada se lee de vuelta con pisos y otros productos", async () => {
    const [h] = await leerExcel(await archivo(await generarPlantilla()));
    expect(h.nombre).toBe("Productos");
    expect(h.filas).toHaveLength(4);
    expect(h.filas[0]).toMatchObject({ errores: [], datos: { presentacion: "piso", piezas_por_caja: "4", m2_por_caja: "1.44", precio_m2: "289", cajas: "10", piezas_sueltas: "2", formato: "60x60" } });
    expect(h.filas[2].datos).toMatchObject({ presentacion: "unidad", unidad: "BULTO", precio: "199", cantidad: "20" });
  });

  it("lee el formato de la hoja actual: encabezados propios, celdas combinadas y precios con $", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("MarcaX");
    ws.addRow(["FORMATO", "SKU", "DESCRIPCIÓN", "PIEZAS X CAJA", "M² X CAJA", "CAJAS EN EXISTENCIA", "PIEZAS SUELTAS", "PRECIO", "FECHA ACTUALIZACIÓN"]);
    ws.addRow(["18x50", "", "Ejemplo Uno", 11, 0.99, 5, "", "$289.00", ""]);
    ws.addRow(["", "", "Ejemplo Dos", 11, 0.99, 0, 3, 249, ""]);
    ws.addRow(["", "", "Ejemplo Sin Caja", "", "", 1, "", 249, ""]);
    ws.mergeCells("A2:A4");
    const otra = wb.addWorksheet("Otros");
    otra.addRow(["CATEGORÍA", "MARCA", "SKU", "DESCRIPCIÓN", "CANTIDAD", "PRECIO"]);
    otra.addRow(["Adhesivos", "Marca Y", "", "Pegamento Ejemplo", 26, 249]);
    const hojas = await leerExcel(await archivo(await wb.xlsx.writeBuffer() as ArrayBuffer));
    expect(hojas.map((h) => [h.nombre, h.tieneMarca, h.filas.length])).toEqual([["MarcaX", false, 3], ["Otros", true, 1]]);
    const [a, b, c] = hojas[0].filas;
    expect(a.datos).toMatchObject({ formato: "18x50", presentacion: "piso", precio_m2: "289", cajas: "5" });
    expect(b.datos).toMatchObject({ formato: "18x50", piezas_sueltas: "3" });      // celda combinada
    expect(c.datos).toMatchObject({ presentacion: "unidad", unidad: "CAJA", cantidad: "1" });
    expect(c.avisos[0]).toMatch(/formato pero no piezas/);
    expect(hojas[1].filas[0].datos).toMatchObject({ marca: "Marca Y", categoria: "Adhesivos", unidad: "PIEZA", cantidad: "26" });
  });

  it("precios de piso desde m² y vista previa de SKU", () => {
    const p = preciosPiso("0.99", "11", "250")!;
    expect(p.caja.toFixed(2)).toBe("247.50");
    expect(p.pieza.toFixed(2)).toBe("22.50");
    expect(prefijoSku("Daltile", "Pisos", "18x50")).toBe("DAL-1850-###");
    expect(prefijoSku("Sin marca", "Adhesivos", "")).toBe("ADH-###");
  });

  it("la pieza se calcula con su área, no dividiendo la caja ya redondeada", () => {
    // 1.5 m² / 7 piezas a $116.69: área 0.214286 m² -> $25.00 (caja $175.04 / 7 daría $25.01)
    const p = preciosPiso("1.5", "7", "116.69")!;
    expect(p.caja.toFixed(2)).toBe("175.04");
    expect(p.pieza.toFixed(2)).toBe("25.00");
    expect(areaFormato("60x60")!.toString()).toBe("0.36");
    expect(areaFormato("18 X 50 cm")!.toString()).toBe("0.09");
    expect(areaFormato("Mosaico")).toBeNull();
  });
});
