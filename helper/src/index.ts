/**
 * hp-scan helper — the small local bridge between a hosted web UI and an
 * eSCL scanner on the LAN.
 *
 * It exists because a browser page fundamentally cannot talk to a printer:
 *   1. no mDNS API, so it cannot find the device
 *   2. mixed-content blocking, so an HTTPS page cannot reach http://192.168.x.x
 *   3. printers send no CORS headers, so response bytes are unreadable
 *
 * This process solves all three and does nothing else. It is deliberately a
 * transparent proxy rather than a rich API: every scan feature lives in the
 * hosted UI, so shipping new features never requires the user to update this
 * binary. Loopback is a "potentially trustworthy origin" per the mixed-content
 * spec, so an HTTPS page may call http://127.0.0.1 freely.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  startDiscovery,
  listScanners,
  getScanner,
  addManual,
  removeManual,
} from "./discovery";

const PORT = Number(process.env.HELPER_PORT ?? 7740);
const VERSION = "0.1.0";

/**
 * Origins allowed to drive this helper. Anything not listed is refused, so a
 * random site the user visits cannot use the helper to reach their LAN.
 *
 * Resolved from three places so that changing the hosted app's domain never
 * requires rebuilding and redistributing this binary:
 *   1. the baked-in defaults below
 *   2. an `hp-scan.config.json` sitting next to the executable
 *   3. the ALLOWED_ORIGINS environment variable
 */
const BAKED_ORIGINS = [
  "https://hp-scan.vercel.app",
  "https://hp-scan-amar-kisoensinghs-projects.vercel.app",
];

function configFileOrigins(): string[] {
  // process.execPath is the compiled binary; in dev it's the bun runtime, in
  // which case the file simply won't exist and we fall through to the defaults.
  const dir = dirname(process.execPath);
  for (const name of ["hp-scan.config.json", "config.json"]) {
    try {
      const raw = readFileSync(join(dir, name), "utf8");
      const parsed = JSON.parse(raw) as { allowedOrigins?: string[] };
      if (Array.isArray(parsed.allowedOrigins)) {
        console.log(`[helper] loaded ${parsed.allowedOrigins.length} origin(s) from ${name}`);
        return parsed.allowedOrigins;
      }
    } catch {
      // Absent or unreadable config is the normal case; ignore it.
    }
  }
  return [];
}

const ALLOWED_ORIGINS = [
  ...BAKED_ORIGINS,
  ...configFileOrigins(),
  ...(process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true; // curl / same-process probes
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const u = new URL(origin);
    // Local dev servers, on any port.
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") return true;
  } catch {
    return false;
  }
  return false;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const h: Record<string, string> = {
    "access-control-allow-origin": origin ?? "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chrome's Private Network Access preflight: without this, a public HTTPS
    // page silently fails to reach the loopback helper.
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
    "access-control-expose-headers": "location, x-escl-location, content-type",
    vary: "origin",
  };
  return h;
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json" },
  });
}

/**
 * Rewrite a device-absolute eSCL URL into a helper-relative one, so the browser
 * keeps talking to the helper rather than trying (and failing) to reach the
 * printer directly.
 */
function rewriteLocation(location: string, scannerId: string, baseUrl: string): string {
  try {
    const loc = new URL(location, baseUrl);
    const basePath = new URL(baseUrl).pathname.replace(/\/+$/, "");
    let rest = loc.pathname;
    if (basePath && rest.startsWith(basePath)) rest = rest.slice(basePath.length);
    return `/v1/scanners/${encodeURIComponent(scannerId)}/escl${rest}${loc.search}`;
  } catch {
    return location;
  }
}

const stopDiscovery = startDiscovery();

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1", // loopback only — never expose this to the network
  // A NextDocument request blocks for as long as the sheet takes to scan.
  idleTimeout: 255,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const origin = req.headers.get("origin");

    if (!isAllowedOrigin(origin)) {
      return new Response("Forbidden origin", { status: 403 });
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    if (path === "/v1/health") {
      return json(req, { ok: true, name: "hp-scan-helper", version: VERSION });
    }

    if (path === "/v1/scanners" && req.method === "GET") {
      return json(req, { scanners: listScanners() });
    }

    if (path === "/v1/scanners/manual" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as {
        host?: string;
        port?: number;
        path?: string;
      };
      if (!body.host) return json(req, { error: "host is required" }, 400);
      return json(req, { scanner: addManual(body.host, body.port ?? 80, body.path ?? "eSCL") });
    }

    // /v1/scanners/:id/escl/<eSCL path...>
    const proxy = path.match(/^\/v1\/scanners\/([^/]+)\/escl(\/.*)?$/);
    if (proxy) {
      const id = decodeURIComponent(proxy[1]);
      const rest = proxy[2] ?? "/";
      const scanner = getScanner(id);
      if (!scanner) return json(req, { error: "Unknown scanner", id }, 404);

      const target = `${scanner.baseUrl.replace(/\/+$/, "")}${rest}${url.search}`;
      const headers = new Headers();
      const ct = req.headers.get("content-type");
      if (ct) headers.set("content-type", ct);

      try {
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
          // Location must be handed back to the caller, not chased.
          redirect: "manual",
          signal: AbortSignal.timeout(250_000),
        });

        const out = new Headers(corsHeaders(req));
        const upstreamCt = upstream.headers.get("content-type");
        if (upstreamCt) out.set("content-type", upstreamCt);

        const loc = upstream.headers.get("location");
        if (loc) {
          const rewritten = rewriteLocation(loc, id, scanner.baseUrl);
          out.set("location", rewritten);
          // Browsers hide `location` on some statuses; mirror it somewhere safe.
          out.set("x-escl-location", rewritten);
        }

        return new Response(upstream.body, { status: upstream.status, headers: out });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[helper] proxy ${req.method} ${target} failed: ${message}`);
        return json(req, { error: "Upstream request failed", detail: message, target }, 502);
      }
    }

    if (path.startsWith("/v1/scanners/") && req.method === "DELETE") {
      const id = decodeURIComponent(path.slice("/v1/scanners/".length));
      return json(req, { removed: removeManual(id) });
    }

    return json(req, { error: "Not found" }, 404);
  },
});

console.log(`[helper] hp-scan-helper ${VERSION} listening on http://127.0.0.1:${server.port}`);
console.log(`[helper] extra allowed origins: ${ALLOWED_ORIGINS.join(", ") || "(localhost only)"}`);

const shutdown = () => {
  stopDiscovery();
  server.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
