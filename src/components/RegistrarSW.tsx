"use client";
/** Registra el service worker de la PWA (solo en producción, para no estorbar en desarrollo). */
import { useEffect } from "react";

export default function RegistrarSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);
  return null;
}
