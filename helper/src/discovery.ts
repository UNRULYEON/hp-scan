/**
 * mDNS discovery of eSCL / AirScan scanners.
 *
 * Browsers have no mDNS API, which is the first of the three reasons this
 * helper process exists at all. We browse _uscan._tcp (and the TLS variant
 * _uscans._tcp) and keep a live map of what's on the network.
 */

import { Bonjour, type Service } from "bonjour-service";

export type Scanner = {
  /** Stable, URL-safe id derived from the device UUID or host:port. */
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  /** Root of the eSCL interface, e.g. http://192.168.1.50/eSCL */
  baseUrl: string;
  /** Whether the feeder and platen are advertised as present. */
  sources: string[];
  duplex: boolean;
  isSimulator: boolean;
  /** True for entries the user typed in by hand, which are the only removable ones. */
  isManual: boolean;
  lastSeen: number;
};

const scanners = new Map<string, Scanner>();
/** Devices added by hand, kept separate so discovery sweeps never evict them. */
const manual = new Map<string, Scanner>();

function txtValue(txt: Record<string, unknown> | undefined, key: string): string {
  const v = txt?.[key];
  if (v == null) return "";
  return Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
}

/**
 * Prefer an IPv4 literal over the .local hostname: some Windows setups resolve
 * .local unreliably, and we already know the address from the mDNS record.
 */
function addressFor(svc: Service): string {
  const v4 = svc.addresses?.find((a) => a.includes(".") && !a.startsWith("169.254."));
  return v4 ?? svc.host ?? "";
}

function toScanner(svc: Service, secure: boolean): Scanner | null {
  const host = addressFor(svc);
  if (!host) return null;

  const txt = svc.txt as Record<string, unknown> | undefined;
  const uuid = txtValue(txt, "uuid");
  const rs = txtValue(txt, "rs") || "eSCL";
  const scheme = secure ? "https" : "http";
  const port = svc.port;
  const authority = (secure && port === 443) || (!secure && port === 80) ? host : `${host}:${port}`;

  const is = txtValue(txt, "is");
  return {
    id: uuid || `${host}-${port}`,
    name: svc.name ?? txtValue(txt, "ty") ?? host,
    model: txtValue(txt, "ty") || svc.name || "Unknown scanner",
    host,
    port,
    baseUrl: `${scheme}://${authority}/${rs.replace(/^\/+|\/+$/g, "")}`,
    sources: is ? is.split(",").map((s) => s.trim()).filter(Boolean) : [],
    duplex: txtValue(txt, "duplex").toUpperCase() === "T",
    isSimulator: /\[SIM\]|Simulator/i.test(`${svc.name} ${txtValue(txt, "note")}`),
    isManual: false,
    lastSeen: Date.now(),
  };
}

export function startDiscovery(): () => void {
  const bonjour = new Bonjour();

  const browse = (type: string, secure: boolean) => {
    const browser = bonjour.find({ type, protocol: "tcp" });
    browser.on("up", (svc) => {
      const s = toScanner(svc, secure);
      if (!s) return;
      const existing = scanners.get(s.id);
      // A device answering on both _uscan and _uscans: keep the plain-HTTP one,
      // since printers ship self-signed certs that we cannot validate.
      if (existing && secure && existing.baseUrl.startsWith("http://")) {
        existing.lastSeen = Date.now();
        return;
      }
      if (!existing) console.log(`[helper] found ${s.model} at ${s.baseUrl}`);
      scanners.set(s.id, s);
    });
    browser.on("down", (svc) => {
      const s = toScanner(svc, secure);
      if (s && scanners.delete(s.id)) console.log(`[helper] lost ${s.model}`);
    });
    return browser;
  };

  const browsers = [browse("uscan", false), browse("uscans", true)];
  // Printers sleep aggressively; re-query so they reappear without a restart.
  const timer = setInterval(() => browsers.forEach((b) => b.update()), 20_000);

  return () => {
    clearInterval(timer);
    browsers.forEach((b) => b.stop());
    bonjour.destroy();
  };
}

export function listScanners(): Scanner[] {
  // Discovered devices first: they are the ones the user actually wants
  // selected by default, and manual entries are usually a fallback or a typo.
  return [...scanners.values(), ...manual.values()].sort((a, b) => {
    if (a.isManual !== b.isManual) return a.isManual ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function getScanner(id: string): Scanner | undefined {
  return manual.get(id) ?? scanners.get(id);
}

/**
 * Escape hatch for networks where mDNS is blocked: point at an IP directly.
 *
 * Accepts what a person would actually type — "192.168.1.50",
 * "192.168.1.50:8080", or "http://192.168.1.50/" — rather than demanding a
 * bare host. An embedded port wins over the `port` argument.
 */
export function addManual(input: string, port = 80, path = "eSCL"): Scanner {
  let host = input
    .trim()
    .replace(/^[a-z]+:\/\//i, "") // strip a pasted scheme
    .replace(/\/.*$/, ""); // and any trailing path

  let resolvedPort = port;
  const withPort = host.match(/^(.+):(\d{1,5})$/);
  if (withPort) {
    host = withPort[1];
    resolvedPort = Number(withPort[2]);
  }

  const authority = resolvedPort === 80 ? host : `${host}:${resolvedPort}`;
  const s: Scanner = {
    id: `manual-${host}-${resolvedPort}`,
    // Name is just the address: the UI shows the address next to the name, and
    // repeating it in both slots reads badly.
    name: authority,
    model: "Handmatig toegevoegd",
    host,
    port: resolvedPort,
    baseUrl: `http://${authority}/${path.replace(/^\/+|\/+$/g, "")}`,
    sources: [],
    duplex: false,
    isSimulator: false,
    isManual: true,
    lastSeen: Date.now(),
  };
  manual.set(s.id, s);
  return s;
}

export function removeManual(id: string): boolean {
  return manual.delete(id);
}
