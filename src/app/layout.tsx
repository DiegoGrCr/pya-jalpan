import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RegistrarSW from "@/components/RegistrarSW";
import { COLOR_TEMA, DESCRIPCION_SISTEMA, NOMBRE_SISTEMA } from "@/lib/marca";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: NOMBRE_SISTEMA,
  description: DESCRIPCION_SISTEMA,
  applicationName: NOMBRE_SISTEMA,
  // iPhone / iPad: se abre como app (sin barra del navegador) al agregarlo a la pantalla de inicio
  appleWebApp: { capable: true, title: NOMBRE_SISTEMA, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: COLOR_TEMA,
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es-MX">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <RegistrarSW />
      </body>
    </html>
  );
}
