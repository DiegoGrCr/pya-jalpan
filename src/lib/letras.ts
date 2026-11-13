/** Importe con letra para documentos en MXN: 3560 → "TRES MIL QUINIENTOS SESENTA PESOS 00/100 M.N." */

const UNIDADES = ["", "UN", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ",
  "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE",
  "VEINTIÚN", "VEINTIDÓS", "VEINTITRÉS", "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const CENTENAS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function hasta999(n: number): string {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100), r = n % 100;
  let t = "";
  if (r < 30) t = UNIDADES[r];
  else { const d = Math.floor(r / 10), u = r % 10; t = DECENAS[d] + (u ? ` Y ${UNIDADES[u]}` : ""); }
  return [CENTENAS[c], t].filter(Boolean).join(" ");
}

function entero(n: number): string {
  if (n === 0) return "CERO";
  const millones = Math.floor(n / 1_000_000), miles = Math.floor((n % 1_000_000) / 1000), resto = n % 1000;
  const partes: string[] = [];
  if (millones) partes.push(millones === 1 ? "UN MILLÓN" : `${entero(millones)} MILLONES`);
  if (miles) partes.push(miles === 1 ? "MIL" : `${hasta999(miles)} MIL`);
  if (resto) partes.push(hasta999(resto));
  return partes.join(" ");
}

export function importeConLetra(valor: number | string): string {
  const centavosTot = Math.round(Number(valor) * 100);
  const pesos = Math.floor(centavosTot / 100), centavos = centavosTot % 100;
  const texto = entero(pesos);
  // "UN MILLÓN DE PESOS", "DOS MILLONES DE PESOS"
  const de = pesos > 0 && pesos % 1_000_000 === 0 ? " DE" : "";
  return `${texto}${de} ${pesos === 1 ? "PESO" : "PESOS"} ${String(centavos).padStart(2, "0")}/100 M.N.`;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
/** "22 de octubre de 2026" en hora de la Ciudad de México. */
export function fechaLarga(iso: string): string {
  const [a, m, d] = new Date(iso).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }).split("-").map(Number);
  return `${d} de ${MESES[m - 1]} de ${a}`;
}
/** "22-10-2026" en hora de la Ciudad de México. */
export function fechaCorta(iso: string): string {
  const [a, m, d] = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-CA", { timeZone: "America/Mexico_City" }).split("-");
  return `${d}-${m}-${a}`;
}
