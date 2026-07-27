/**
 * Client for the local hp-scan helper.
 *
 * The helper listens on loopback, which the mixed-content spec treats as a
 * trustworthy origin — so this hosted HTTPS page is allowed to call it.
 */

export const HELPER_ORIGIN =
  (import.meta.env.VITE_HELPER_ORIGIN as string | undefined) ?? "http://127.0.0.1:7740";

export type Scanner = {
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
  baseUrl: string;
  sources: string[];
  duplex: boolean;
  isSimulator: boolean;
  lastSeen: number;
};

export class HelperUnavailableError extends Error {
  constructor() {
    super("Kan de hp-scan-helper niet bereiken");
    this.name = "HelperUnavailableError";
  }
}

async function helperFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${HELPER_ORIGIN}${path}`, init);
  } catch {
    // A network-level failure here almost always means the helper isn't running
    // (or Chrome blocked the private-network preflight).
    throw new HelperUnavailableError();
  }
}

export async function checkHelper(): Promise<{ version: string }> {
  const res = await helperFetch("/v1/health");
  if (!res.ok) throw new HelperUnavailableError();
  return res.json();
}

export async function listScanners(): Promise<Scanner[]> {
  const res = await helperFetch("/v1/scanners");
  if (!res.ok) throw new Error(`Helper gaf status ${res.status} terug`);
  const body = (await res.json()) as { scanners: Scanner[] };
  return body.scanners;
}

export async function addManualScanner(host: string, port = 80): Promise<Scanner> {
  const res = await helperFetch("/v1/scanners/manual", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ host, port }),
  });
  if (!res.ok) throw new Error(`Kan de scanner op ${host} niet toevoegen`);
  const body = (await res.json()) as { scanner: Scanner };
  return body.scanner;
}

/** Issue a request against a scanner's eSCL interface via the helper proxy. */
export function esclFetch(
  scannerId: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const p = path.startsWith("/") ? path : `/${path}`;
  return helperFetch(`/v1/scanners/${encodeURIComponent(scannerId)}/escl${p}`, init);
}

/** Follow a helper-relative job URL returned in a rewritten Location header. */
export function helperUrl(relativePath: string): string {
  return `${HELPER_ORIGIN}${relativePath}`;
}
