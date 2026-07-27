/**
 * eSCL / AirScan client, spoken directly from the browser.
 *
 * All requests go through the local helper's transparent proxy, so paths here
 * are helper-relative. Keeping the protocol in the hosted app (rather than in
 * the helper) means new scan features ship as a page reload, with no need for
 * anyone to update the installed binary.
 *
 * eSCL expresses all geometry in units of 1/300 inch, independent of the
 * scan resolution.
 */

export const UNITS_PER_INCH = 300;

export type InputSource = "Platen" | "Feeder";
export type ColorMode = "BlackAndWhite1" | "Grayscale8" | "RGB24";

export type PaperSize = {
  id: string;
  label: string;
  /** width/height in 1/300 inch */
  width: number;
  height: number;
};

export const PAPER_SIZES: PaperSize[] = [
  { id: "a4", label: "A4", width: 2480, height: 3508 },
  { id: "letter", label: "Letter", width: 2550, height: 3300 },
  { id: "legal", label: "Legal", width: 2550, height: 4200 },
  { id: "a3", label: "A3", width: 3507, height: 4960 },
  { id: "a5", label: "A5", width: 1754, height: 2480 },
];

export type SourceCaps = {
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight: number;
  resolutions: number[];
  colorModes: ColorMode[];
  formats: string[];
};

export type Capabilities = {
  makeAndModel: string;
  serialNumber: string;
  version: string;
  platen?: SourceCaps;
  adfSimplex?: SourceCaps;
  adfDuplex?: SourceCaps;
  feederCapacity?: number;
  /** True when the device reports whether paper is sitting in the feeder. */
  detectsPaperLoaded: boolean;
};

export type ScannerStatus = {
  state: string;
  adfState?: string;
  /** Convenience: true when the feeder has paper in it right now. */
  adfLoaded: boolean;
};

export type ScanRequest = {
  source: InputSource;
  duplex: boolean;
  colorMode: ColorMode;
  resolution: number;
  width: number;
  height: number;
  /** eSCL "Intent" — hints the device's own image processing. */
  intent?: "Document" | "Photo" | "TextAndGraphic" | "Preview";
};

// --- parsing ---------------------------------------------------------------

/** eSCL namespaces vary by vendor, so match on local name only. */
function local(el: Element | Document, name: string): Element | undefined {
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === name) return all[i];
  }
  return undefined;
}

function localAll(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const all = el.getElementsByTagName("*");
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === name) out.push(all[i]);
  }
  return out;
}

function num(el: Element | undefined, name: string, fallback: number): number {
  if (!el) return fallback;
  const found = local(el, name);
  const v = Number(found?.textContent?.trim());
  return Number.isFinite(v) ? v : fallback;
}

function parseSourceCaps(el: Element | undefined): SourceCaps | undefined {
  if (!el) return undefined;

  const resolutions = [
    ...new Set(
      localAll(el, "XResolution")
        .map((r) => Number(r.textContent?.trim()))
        .filter((n) => Number.isFinite(n) && n > 0),
    ),
  ].sort((a, b) => a - b);

  const colorModes = [
    ...new Set(localAll(el, "ColorMode").map((c) => c.textContent?.trim() ?? "")),
  ].filter((c): c is ColorMode =>
    c === "BlackAndWhite1" || c === "Grayscale8" || c === "RGB24",
  );

  const formats = [
    ...new Set(
      [...localAll(el, "DocumentFormat"), ...localAll(el, "DocumentFormatExt")]
        .map((f) => f.textContent?.trim() ?? "")
        .filter(Boolean),
    ),
  ];

  return {
    minWidth: num(el, "MinWidth", 16),
    maxWidth: num(el, "MaxWidth", 2550),
    minHeight: num(el, "MinHeight", 16),
    maxHeight: num(el, "MaxHeight", 3508),
    resolutions: resolutions.length ? resolutions : [75, 150, 300, 600],
    colorModes: colorModes.length ? colorModes : ["RGB24", "Grayscale8"],
    formats: formats.length ? formats : ["image/jpeg"],
  };
}

export function parseCapabilities(xml: string): Capabilities {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  if (local(doc, "parsererror")) throw new Error("Scanner returned malformed capabilities XML");

  const adfOptions = localAll(doc, "AdfOption").map((o) => o.textContent?.trim() ?? "");

  return {
    makeAndModel: local(doc, "MakeAndModel")?.textContent?.trim() ?? "Unknown scanner",
    serialNumber: local(doc, "SerialNumber")?.textContent?.trim() ?? "",
    version: local(doc, "Version")?.textContent?.trim() ?? "",
    platen: parseSourceCaps(local(doc, "PlatenInputCaps")),
    adfSimplex: parseSourceCaps(local(doc, "AdfSimplexInputCaps")),
    adfDuplex: parseSourceCaps(local(doc, "AdfDuplexInputCaps")),
    feederCapacity: Number(local(doc, "FeederCapacity")?.textContent?.trim()) || undefined,
    detectsPaperLoaded: adfOptions.includes("DetectPaperLoaded"),
  };
}

export function parseStatus(xml: string): ScannerStatus {
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const adfState = local(doc, "AdfState")?.textContent?.trim();
  return {
    state: local(doc, "State")?.textContent?.trim() ?? "Unknown",
    adfState,
    adfLoaded: adfState === "ScannerAdfLoaded",
  };
}

// --- request building ------------------------------------------------------

export function buildScanSettings(req: ScanRequest): string {
  // Some firmware rejects a job whose region exceeds the source's maximum, so
  // callers are expected to have clamped width/height to the source caps.
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings
    xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"
    xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version>
  <scan:Intent>${req.intent ?? "Document"}</scan:Intent>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${Math.round(req.width)}</pwg:Width>
      <pwg:Height>${Math.round(req.height)}</pwg:Height>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${req.source}</pwg:InputSource>
  <scan:Duplex>${req.duplex ? "true" : "false"}</scan:Duplex>
  <scan:ColorMode>${req.colorMode}</scan:ColorMode>
  <scan:XResolution>${req.resolution}</scan:XResolution>
  <scan:YResolution>${req.resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
}

export function capsForRequest(
  caps: Capabilities,
  source: InputSource,
  duplex: boolean,
): SourceCaps | undefined {
  if (source === "Platen") return caps.platen;
  return duplex ? caps.adfDuplex : (caps.adfSimplex ?? caps.adfDuplex);
}
