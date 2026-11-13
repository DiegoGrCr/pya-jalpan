"use client";
/** Edición de un producto existente. */
import { use, useEffect, useState } from "react";
import ProductoForm from "@/components/ProductoForm";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { PRODUCTO_VACIO, ProductoForm as Datos, Presentacion } from "@/lib/productos";

interface Fila {
  id: string; sku: string; nombre: string; formato: string | null; presentacion: Presentacion; unidad_base: string;
  piezas_por_caja: number | null; m2_por_caja: string | null; precio_m2: string | null; codigo_barras: string | null;
  comentarios: string | null; activo: boolean; marcas: { nombre: string } | null; categorias: { nombre: string } | null;
  unidades_venta: { nombre: string; es_base: boolean; precios: { precio: string; lista_id: string }[] }[];
}

export default function EditarProducto({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [datos, setDatos] = useState<Datos | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const sb = supabase();
        const [{ data, error }, lp] = await Promise.all([
          sb.from("productos").select("id, sku, nombre, formato, presentacion, unidad_base, piezas_por_caja, m2_por_caja, precio_m2, codigo_barras, comentarios, activo, marcas(nombre), categorias(nombre), unidades_venta(nombre, es_base, precios(precio, lista_id))").eq("id", id).maybeSingle(),
          sb.from("listas_precios").select("id").eq("predeterminada", true).maybeSingle(),
        ]);
        if (error) throw error;
        if (!data) throw new Error("Producto no encontrado.");
        const p = data as unknown as Fila;
        const precio = (u?: Fila["unidades_venta"][number]) => u?.precios.find((x) => x.lista_id === lp.data?.id)?.precio ?? "";
        const caja = p.unidades_venta.find((u) => u.nombre === "CAJA" && !u.es_base);
        const base = p.unidades_venta.find((u) => u.es_base);
        setDatos({
          ...PRODUCTO_VACIO, id: p.id, sku: p.sku, nombre: p.nombre, formato: p.formato ?? "", presentacion: p.presentacion,
          unidad: p.unidad_base, marca: p.marcas?.nombre ?? "", categoria: p.categorias?.nombre ?? "",
          piezas_por_caja: p.piezas_por_caja?.toString() ?? "", m2_por_caja: p.m2_por_caja ? String(Number(p.m2_por_caja)) : "",
          precio_m2: p.precio_m2 ?? "", codigo_barras: p.codigo_barras ?? "", comentarios: p.comentarios ?? "", activo: p.activo,
          precio: p.presentacion === "unidad" ? precio(base) : "",
          // Si el precio guardado no coincide con el calculado desde m² (sin redondeo), se escribió a mano
          ...(() => {
            if (p.presentacion !== "piso" || !p.precio_m2 || !p.m2_por_caja || !p.piezas_por_caja) return { precio_caja: "", precio_pieza: "" };
            const pc = precio(caja), pp = precio(base);
            const calcCaja = Number(p.m2_por_caja) * Number(p.precio_m2), calcPieza = calcCaja / p.piezas_por_caja;
            const difCaja = pc !== "" && Math.abs(Number(pc) - calcCaja) > 0.000001;
            const difPieza = pp !== "" && Math.abs(Number(pp) - (difCaja ? Number(pc) / p.piezas_por_caja : calcPieza)) > 0.000001;
            return difCaja || difPieza ? { precio_caja: String(Number(pc)), precio_pieza: difPieza ? String(Number(pp)) : "" } : { precio_caja: "", precio_pieza: "" };
          })(),
        });
      } catch (e) { setError(mensajeError(e)); }
    })();
  }, [id]);

  if (error) return <div className="p-5 text-[var(--peligro)]">{error}</div>;
  if (!datos) return <div className="p-5">Cargando…</div>;
  return <ProductoForm inicial={datos} esNuevo={false} />;
}
