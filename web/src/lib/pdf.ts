/**
 * PDF assembly, done entirely in the browser with pdf-lib.
 *
 * Keeping this client-side means reordering, rotating and deleting pages are
 * instant local operations, and the finished file never leaves the machine.
 */

import { PDFDocument, degrees } from "pdf-lib";
import { UNITS_PER_INCH } from "./escl";

/** eSCL's 1/300 inch units -> PDF points (1/72 inch). */
function unitsToPoints(units: number): number {
  return (units / UNITS_PER_INCH) * 72;
}

export type PdfPage = {
  blob: Blob;
  /** Clockwise rotation applied by the user, in degrees. */
  rotation: 0 | 90 | 180 | 270;
  /** Physical page dimensions in 1/300 inch, as scanned. */
  widthUnits: number;
  heightUnits: number;
};

/**
 * Re-encode an image with rotation baked in.
 *
 * pdf-lib can rotate at draw time, but its rotation pivots on the image origin
 * and interacts awkwardly with page boxes; baking the pixels keeps the PDF
 * geometry trivial and guarantees the thumbnail matches the output.
 */
export async function bakeRotation(blob: Blob, rotation: number): Promise<Blob> {
  if (rotation % 360 === 0) return blob;

  const bitmap = await createImageBitmap(blob);
  const swap = rotation === 90 || rotation === 270;
  const w = swap ? bitmap.height : bitmap.width;
  const h = swap ? bitmap.width : bitmap.height;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Kan geen 2D-canvascontext maken");

  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Kan de gedraaide pagina niet opslaan"))),
      "image/jpeg",
      0.92,
    );
  });
}

export type BuildPdfOptions = {
  title?: string;
  onProgress?: (done: number, total: number) => void;
};

export async function buildPdf(pages: PdfPage[], opts: BuildPdfOptions = {}): Promise<Blob> {
  if (pages.length === 0) throw new Error("Er zijn geen pagina's om op te slaan");

  const pdf = await PDFDocument.create();
  pdf.setProducer("hp-scan");
  pdf.setCreator("hp-scan");
  if (opts.title) pdf.setTitle(opts.title);
  pdf.setCreationDate(new Date());

  for (const [i, page] of pages.entries()) {
    const bytes = new Uint8Array(await (await bakeRotation(page.blob, page.rotation)).arrayBuffer());

    // Sniff the container rather than trusting the blob's declared type: the
    // canvas re-encode always produces JPEG, but untouched pages come straight
    // from the scanner and could be either.
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    const image = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);

    const swap = page.rotation === 90 || page.rotation === 270;
    const wUnits = swap ? page.heightUnits : page.widthUnits;
    const hUnits = swap ? page.widthUnits : page.heightUnits;

    const pdfPage = pdf.addPage([unitsToPoints(wUnits), unitsToPoints(hUnits)]);
    pdfPage.drawImage(image, {
      x: 0,
      y: 0,
      width: pdfPage.getWidth(),
      height: pdfPage.getHeight(),
      rotate: degrees(0),
    });

    opts.onProgress?.(i + 1, pages.length);
  }

  // slice() gives a Uint8Array whose buffer is exactly the right length.
  const bytes = (await pdf.save()).slice();
  return new Blob([bytes.buffer as ArrayBuffer], { type: "application/pdf" });
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|]/g, "").trim() || "scan";
  return cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
}
