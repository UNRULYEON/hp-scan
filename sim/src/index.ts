/**
 * A simulated eSCL / AirScan scanner that behaves like an HP OfficeJet Pro 7740.
 *
 * Implements the six endpoints a real device exposes, advertises itself over
 * mDNS as _uscan._tcp exactly as the printer does, and models a physical paper
 * tray so ADF batch scanning can be developed end to end with no hardware.
 *
 * Deliberately serves NO CORS headers, because real printers don't either —
 * that constraint is the entire reason the local helper exists, so the
 * simulator must reproduce it.
 *
 * Extra, non-eSCL control endpoints live under /sim/ for driving the fixture.
 */

import { Bonjour } from "bonjour-service";
import { capabilitiesFor } from "./capabilities";
import { renderPageJpeg, type PageSpec } from "./pages";

const PORT = Number(process.env.SIM_PORT ?? 8090);
const ADVERTISE = process.env.SIM_MDNS !== "0";
// Cap the rendered long edge so dev iteration stays fast. Physical page size is
// carried by the scan region, not the pixel count, so this stays correct.
const MAX_EDGE = Number(process.env.SIM_MAX_EDGE ?? 2000);
// Per-page delay, mimicking the ~2s/sheet the real 7740 takes at 300dpi.
const PAGE_DELAY_MS = Number(process.env.SIM_PAGE_DELAY_MS ?? 1200);

type ColorMode = PageSpec["colorMode"];

type ScanSettings = {
  source: "Platen" | "Feeder";
  duplex: boolean;
  colorMode: ColorMode;
  resolution: number;
  format: string;
  regionW: number; // 1/300 inch
  regionH: number;
};

type Job = {
  id: string;
  settings: ScanSettings;
  pending: PageSpec[];
  delivered: number;
  state: "Processing" | "Completed" | "Canceled";
  createdAt: number;
};

const jobs = new Map<string, Job>();

/** Sheets physically sitting in the feeder. */
let sheetsInFeeder = Number(process.env.SIM_SHEETS ?? 5);
/** Monotonic sheet counter so page numbers keep climbing across batches. */
let sheetCounter = 0;

function text(v: string) {
  return v;
}

function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<[a-zA-Z]+:${tag}>([^<]*)</[a-zA-Z]+:${tag}>`));
  return m?.[1]?.trim();
}

function parseScanSettings(xml: string): ScanSettings {
  const source = pick(xml, "InputSource") === "Feeder" ? "Feeder" : "Platen";
  const duplex = (pick(xml, "Duplex") ?? "false").toLowerCase() === "true";
  const colorRaw = pick(xml, "ColorMode") ?? "RGB24";
  const colorMode: ColorMode =
    colorRaw === "BlackAndWhite1" || colorRaw === "Grayscale8" ? colorRaw : "RGB24";
  const resolution = Number(pick(xml, "XResolution") ?? 300) || 300;
  const format = pick(xml, "DocumentFormatExt") ?? pick(xml, "DocumentFormat") ?? "image/jpeg";
  // Default region is A4 in 1/300 inch units.
  const regionW = Number(pick(xml, "Width") ?? 2480) || 2480;
  const regionH = Number(pick(xml, "Height") ?? 3508) || 3508;
  return { source, duplex, colorMode, resolution, format, regionW, regionH };
}

function pixelSize(s: ScanSettings): { w: number; h: number } {
  const scale = s.resolution / 300;
  let w = Math.round(s.regionW * scale);
  let h = Math.round(s.regionH * scale);
  const longest = Math.max(w, h);
  if (longest > MAX_EDGE) {
    const k = MAX_EDGE / longest;
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  return { w, h };
}

function buildPages(s: ScanSettings): PageSpec[] {
  const { w, h } = pixelSize(s);
  const out: PageSpec[] = [];
  const base = { widthPx: w, heightPx: h, colorMode: s.colorMode } as const;

  if (s.source === "Platen") {
    out.push({ ...base, index: ++sheetCounter, side: "front" });
    return out;
  }

  // Feeder: consume the whole tray, two images per sheet when duplexing.
  const sheets = sheetsInFeeder;
  sheetsInFeeder = 0;
  for (let i = 0; i < sheets; i++) {
    const n = ++sheetCounter;
    out.push({ ...base, index: n, side: "front" });
    if (s.duplex) out.push({ ...base, index: n, side: "back" });
  }
  return out;
}

function adfState(): string {
  return sheetsInFeeder > 0 ? "ScannerAdfLoaded" : "ScannerAdfEmpty";
}

function scannerStatusXml(): string {
  const busy = [...jobs.values()].some((j) => j.state === "Processing");
  const jobEntries = [...jobs.values()]
    .slice(-8)
    .map(
      (j) => `    <scan:JobInfo>
      <pwg:JobUri>/eSCL/ScanJobs/${j.id}</pwg:JobUri>
      <pwg:JobUuid>${j.id}</pwg:JobUuid>
      <scan:Age>${Math.round((Date.now() - j.createdAt) / 1000)}</scan:Age>
      <pwg:ImagesCompleted>${j.delivered}</pwg:ImagesCompleted>
      <pwg:JobState>${j.state}</pwg:JobState>
      <pwg:JobStateReasons>
        <pwg:JobStateReason>${j.state === "Processing" ? "JobScanning" : "JobCompletedSuccessfully"}</pwg:JobStateReason>
      </pwg:JobStateReasons>
    </scan:JobInfo>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerStatus
    xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03"
    xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version>
  <pwg:State>${busy ? "Processing" : "Idle"}</pwg:State>
  <scan:AdfState>${adfState()}</scan:AdfState>
  <scan:Jobs>
${jobEntries}
  </scan:Jobs>
</scan:ScannerStatus>
`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const host = req.headers.get("host") ?? `localhost:${PORT}`;

    // --- eSCL ---------------------------------------------------------------

    if (req.method === "GET" && path === "/eSCL/ScannerCapabilities") {
      return new Response(capabilitiesFor(host), {
        headers: { "content-type": "text/xml;charset=UTF-8" },
      });
    }

    if (req.method === "GET" && path === "/eSCL/ScannerStatus") {
      return new Response(scannerStatusXml(), {
        headers: { "content-type": "text/xml;charset=UTF-8" },
      });
    }

    if (req.method === "POST" && path === "/eSCL/ScanJobs") {
      const body = await req.text();
      const settings = parseScanSettings(body);

      if (settings.source === "Feeder" && sheetsInFeeder === 0) {
        // What the real device does when you start a feeder job with no paper.
        return new Response(text("Conflict: ADF empty"), { status: 409 });
      }

      const id = crypto.randomUUID();
      const job: Job = {
        id,
        settings,
        pending: buildPages(settings),
        delivered: 0,
        state: "Processing",
        createdAt: Date.now(),
      };
      jobs.set(id, job);
      console.log(
        `[sim] job ${id.slice(0, 8)} source=${settings.source} duplex=${settings.duplex} ` +
          `dpi=${settings.resolution} color=${settings.colorMode} pages=${job.pending.length}`,
      );
      return new Response(null, {
        status: 201,
        headers: { location: `http://${host}/eSCL/ScanJobs/${id}` },
      });
    }

    const nextDoc = path.match(/^\/eSCL\/ScanJobs\/([^/]+)\/NextDocument$/);
    if (req.method === "GET" && nextDoc) {
      const job = jobs.get(nextDoc[1]);
      if (!job) return new Response("Not Found", { status: 404 });
      if (job.state === "Canceled") return new Response("Not Found", { status: 404 });

      const spec = job.pending.shift();
      if (!spec) {
        // 404 on NextDocument is how eSCL signals "job finished".
        job.state = "Completed";
        return new Response("Not Found", { status: 404 });
      }

      await sleep(PAGE_DELAY_MS);
      const jpegBytes = renderPageJpeg(spec);
      job.delivered++;
      if (job.pending.length === 0) job.state = "Completed";
      console.log(`[sim] job ${job.id.slice(0, 8)} -> page ${job.delivered} (${jpegBytes.length}b)`);
      return new Response(jpegBytes, {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(jpegBytes.length),
        },
      });
    }

    const jobPath = path.match(/^\/eSCL\/ScanJobs\/([^/]+)$/);
    if (req.method === "DELETE" && jobPath) {
      const job = jobs.get(jobPath[1]);
      if (!job) return new Response("Not Found", { status: 404 });
      job.state = "Canceled";
      job.pending = [];
      console.log(`[sim] job ${job.id.slice(0, 8)} canceled`);
      return new Response(null, { status: 200 });
    }

    // --- fixture control ----------------------------------------------------

    if (path === "/sim/state") {
      return Response.json({
        model: "HP OfficeJet Pro 7740",
        sheetsInFeeder,
        adfState: adfState(),
        jobs: [...jobs.values()].map((j) => ({
          id: j.id,
          state: j.state,
          delivered: j.delivered,
          remaining: j.pending.length,
        })),
      });
    }

    if (path === "/sim/load") {
      sheetsInFeeder = Math.max(0, Number(url.searchParams.get("sheets") ?? 5));
      console.log(`[sim] feeder loaded with ${sheetsInFeeder} sheet(s)`);
      return Response.json({ sheetsInFeeder, adfState: adfState() });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`[sim] HP OfficeJet Pro 7740 (simulated) on http://localhost:${server.port}`);
console.log(`[sim] feeder: ${sheetsInFeeder} sheet(s) — POST /sim/load?sheets=N to change`);

if (ADVERTISE) {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: "HP OfficeJet Pro 7740 [SIM]",
    type: "uscan",
    protocol: "tcp",
    port: server.port,
    txt: {
      txtvers: "1",
      vers: "2.63",
      ty: "HP OfficeJet Pro 7740",
      rs: "eSCL",
      representation: "/icon.png",
      adminurl: `http://localhost:${server.port}/`,
      uuid: "3ca9a1d0-1f4b-4c8a-9f1e-0a5b7c2d9e00",
      is: "platen,adf",
      cs: "binary,grayscale,color",
      duplex: "T",
      pdl: "application/pdf,image/jpeg",
      note: "Simulator",
    },
  });
  console.log(`[sim] advertising _uscan._tcp as "${service.name}"`);

  const shutdown = () => {
    bonjour.unpublishAll(() => {
      bonjour.destroy();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
