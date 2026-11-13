/** Usuarios que inician sesión con nombre de usuario en lugar de correo. */
export const DOMINIO_USUARIOS = "usuarios.local";

export const ROLES = {
  administrador: "Administrador",
  gerente: "Gerente de sucursal",
  cajero: "Vendedor / cajero",
  almacenista: "Almacenista",
  facturacion: "Facturación",
} as const;
export type Rol = keyof typeof ROLES;

export const USUARIO_VALIDO = /^[a-z0-9][a-z0-9._-]{2,29}$/;

/** "Principal" -> "principal@usuarios.local"; un correo se deja igual. */
export function correoDeUsuario(entrada: string): string {
  const t = entrada.trim().toLowerCase();
  return t.includes("@") ? t : `${t}@${DOMINIO_USUARIOS}`;
}
