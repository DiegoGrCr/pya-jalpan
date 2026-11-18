/**
 * Convierte la primera página del PDF de la nota en imagen PNG (para pegarla en WhatsApp
 * como foto o descargarla). Usa pdf.js solo en el navegador y bajo demanda.
 */
export async function pdfAPng(pdf: Blob, escala = 2): Promise<Blob> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()) }).promise;
  try {
    const pagina = await doc.getPage(1);
    const vista = pagina.getViewport({ scale: escala });
    const lienzo = document.createElement("canvas");
    lienzo.width = Math.ceil(vista.width);
    lienzo.height = Math.ceil(vista.height);
    const ctx = lienzo.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, lienzo.width, lienzo.height);
    await pagina.render({ canvasContext: ctx, viewport: vista }).promise;
    return await new Promise<Blob>((ok, mal) => lienzo.toBlob((b) => (b ? ok(b) : mal(new Error("No se pudo generar la imagen"))), "image/png"));
  } finally {
    await doc.destroy();
  }
}

/** Copia una imagen PNG al portapapeles (para pegar con Ctrl+V en WhatsApp Web o de escritorio). */
export async function copiarImagen(png: Blob): Promise<boolean> {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    return true;
  } catch {
    return false;
  }
}
