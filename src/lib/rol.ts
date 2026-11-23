"use client";
/** Rol del usuario actual (para ocultar botones de operación a Contabilidad, que es solo consulta). */
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase/client";

export function useSoloConsulta(): boolean {
  const [solo, setSolo] = useState(false);
  useEffect(() => {
    (async () => {
      const sb = supabase();
      const { data: { user } } = await sb.auth.getUser();
      if (!user) return;
      const { data } = await sb.from("perfiles").select("rol").eq("user_id", user.id).maybeSingle();
      setSolo((data as { rol?: string } | null)?.rol === "facturacion");
    })();
  }, []);
  return solo;
}

/** Descarga un libro de Excel ya armado */
export async function descargarLibro(wb: { xlsx: { writeBuffer: () => Promise<ArrayBuffer> } }, archivo: string) {
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = archivo;
  a.click(); URL.revokeObjectURL(a.href);
}
