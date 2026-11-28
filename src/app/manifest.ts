import type { MetadataRoute } from "next";
import { COLOR_TEMA, DESCRIPCION_SISTEMA, NOMBRE_SISTEMA } from "@/lib/marca";

/** Manifiesto de la PWA: permite instalar el sistema como app en celular, tableta y computadora. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: NOMBRE_SISTEMA,
    short_name: NOMBRE_SISTEMA,
    description: DESCRIPCION_SISTEMA,
    lang: "es-MX",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#ffffff",
    theme_color: COLOR_TEMA,
    categories: ["business", "productivity", "finance"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Punto de venta", url: "/pos", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Capturar venta", url: "/ventas/capturar", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Agenda de envíos", url: "/agenda", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
