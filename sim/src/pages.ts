/**
 * Procedural "scanned page" generator.
 *
 * Produces JPEGs that look enough like a real scan (off-white paper, slight
 * skew, sensor noise, a big page number) to exercise the UI's thumbnailing,
 * ordering and PDF assembly without needing any binary fixtures in the repo.
 */

import jpeg from "jpeg-js";

// 5x7 bitmap digits, one string per row, MSB left.
const DIGITS: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

type Raster = { w: number; h: number; px: Uint8Array };

function blank(w: number, h: number): Raster {
  const px = new Uint8Array(w * h * 4);
  px.fill(255);
  return { w, h, px };
}

function set(r: Raster, x: number, y: number, v: number) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
  const i = (y * r.w + x) * 4;
  r.px[i] = v;
  r.px[i + 1] = v;
  r.px[i + 2] = v;
  r.px[i + 3] = 255;
}

function fillRect(r: Raster, x0: number, y0: number, w: number, h: number, v: number) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) set(r, x, y, v);
}

function drawDigits(r: Raster, text: string, x0: number, y0: number, scale: number, v: number) {
  let cx = x0;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (glyph) {
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (glyph[gy][gx] === "1") fillRect(r, cx + gx * scale, y0 + gy * scale, scale, scale, v);
        }
      }
    }
    cx += 6 * scale;
  }
}

/** Deterministic PRNG so a given page always renders identically. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export type PageSpec = {
  /** 1-based sheet number, printed large on the page. */
  index: number;
  /** Rendered as "back" pages in duplex so front/back are distinguishable. */
  side: "front" | "back";
  widthPx: number;
  heightPx: number;
  colorMode: "BlackAndWhite1" | "Grayscale8" | "RGB24";
};

function render(spec: PageSpec): Raster {
  const { widthPx: w, heightPx: h, index, side } = spec;
  const r = blank(w, h);
  const rand = rng(index * 7919 + (side === "back" ? 31 : 17));

  // Paper tone: slightly off-white, darker at the edges like a real platen scan.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      const vignette = edge < 24 ? (24 - edge) * 1.5 : 0;
      set(r, x, y, Math.max(0, 248 - vignette - rand() * 6));
    }
  }

  const margin = Math.round(w * 0.1);
  const lineH = Math.max(2, Math.round(h * 0.006));
  const gap = lineH * 3;
  let y = Math.round(h * 0.2);

  // A heading bar, then paragraphs of "text" as grey rules of varying length.
  fillRect(r, margin, y, Math.round(w * 0.45), lineH * 3, 40);
  y += lineH * 3 + gap * 3;

  while (y < h - margin - gap) {
    const isParaBreak = rand() < 0.12;
    if (isParaBreak) {
      y += gap * 2;
      continue;
    }
    const len = Math.round((w - margin * 2) * (0.55 + rand() * 0.45));
    fillRect(r, margin, y, len, lineH, 70 + Math.round(rand() * 40));
    y += lineH + gap;
  }

  // Big page number, bottom-right, so ordering is obvious at thumbnail size.
  const scale = Math.max(2, Math.round(h / 120));
  const label = String(index);
  const labelW = label.length * 6 * scale;
  drawDigits(r, label, w - margin - labelW, h - margin - 7 * scale, scale, 20);

  // Back sides get a marker bar so duplex output is visually verifiable.
  if (side === "back") fillRect(r, margin, h - margin - 7 * scale, 8 * scale, 7 * scale, 20);

  if (spec.colorMode === "BlackAndWhite1") {
    for (let i = 0; i < r.px.length; i += 4) {
      const v = r.px[i] > 170 ? 255 : 0;
      r.px[i] = r.px[i + 1] = r.px[i + 2] = v;
    }
  }
  return r;
}

export function renderPageJpeg(spec: PageSpec, quality = 80): Buffer {
  const r = render(spec);
  const { data } = jpeg.encode({ data: Buffer.from(r.px), width: r.w, height: r.h }, quality);
  return data;
}
