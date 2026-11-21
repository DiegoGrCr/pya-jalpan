"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase, mensajeError } from "@/lib/supabase/client";
import { correoDeUsuario } from "@/lib/usuarios";
import { iniciarSesionUnica, mensajeOcupada, salirLocal } from "@/lib/sesion";

/** Avisos al regresar al login porque la sesión se cerró desde otro lado */
const MOTIVOS: Record<string, string> = {
  otro: "Tu sesión se cerró porque este usuario entró desde otro equipo.",
  admin: "Un administrador cerró tu sesión.",
};

export default function Login() {
  const router = useRouter();
  const [correo, setCorreo] = useState("");
  const [contrasena, setContrasena] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    const m = new URLSearchParams(window.location.search).get("motivo");
    if (m && MOTIVOS[m]) setError(MOTIVOS[m]);
  }, []);

  const entrar = async (e: React.FormEvent) => {
    e.preventDefault();
    setCargando(true); setError(null);
    try {
      const { error } = await supabase().auth.signInWithPassword({ email: correoDeUsuario(correo), password: contrasena });
      if (error) throw error;
      // Un usuario, una sesión: si ya está abierto en otro equipo, no se deja entrar
      const s = await iniciarSesionUnica().catch(async (e) => { await salirLocal(); throw e; });
      if (s.estado === "ocupada") { await salirLocal(); setError(mensajeOcupada(s)); return; }
      const volver = new URLSearchParams(window.location.search).get("volver");
      router.replace(volver && volver.startsWith("/") && !volver.startsWith("//") ? volver : "/pos");
      router.refresh();
    } catch (err) {
      const m = mensajeError(err);
      setError(/Invalid login/i.test(m) ? "Usuario o contraseña incorrectos." : m);
    } finally { setCargando(false); }
  };

  return (
    <main className="min-h-screen grid place-items-center bg-[var(--fondo)] text-[var(--texto)] p-4">
      <form onSubmit={entrar} className="w-full max-w-sm bg-[var(--panel)] rounded-lg p-6 flex flex-col gap-3 shadow">
        <h1 className="text-xl font-semibold">Iniciar sesión</h1>
        <label className="flex flex-col gap-1 text-sm">Usuario o correo
          <input type="text" required autoCapitalize="none" spellCheck={false} autoComplete="username" value={correo} onChange={(e) => setCorreo(e.target.value)} className="border rounded px-3 py-2 bg-[var(--panel)]" />
        </label>
        <label className="flex flex-col gap-1 text-sm">Contraseña
          <input type="password" required autoComplete="current-password" value={contrasena} onChange={(e) => setContrasena(e.target.value)} className="border rounded px-3 py-2 bg-[var(--panel)]" />
        </label>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <button disabled={cargando} className="btn-primario py-2 disabled:opacity-50">{cargando ? "Entrando…" : "Entrar"}</button>
      </form>
    </main>
  );
}
