import type { Scanner } from "./helper";

/**
 * HP printers advertise eSCL twice: `_uscan._tcp` on :8080 (HTTP, works) and
 * `_uscans._tcp` on :443 (HTTPS, self-signed, does not). The UI hides ports
 * 80 and 443, so the TLS one shows up as a bare IP that then fails.
 *
 * Keep one entry per host, preferring HTTP with an explicit port. Applied in
 * the hosted UI so already-installed helpers pick this up on a page reload.
 */
export function preferredScanners(scanners: Scanner[]): Scanner[] {
  const bestByHost = new Map<string, Scanner>();
  for (const s of scanners) {
    const prev = bestByHost.get(s.host);
    if (!prev || scannerRank(s) > scannerRank(prev)) bestByHost.set(s.host, s);
  }
  const keep = new Set(bestByHost.values());
  return scanners.filter((s) => keep.has(s));
}

function scannerRank(s: Scanner): number {
  let n = 0;
  if (!s.baseUrl.startsWith("https://")) n += 100;
  if (s.port !== 80 && s.port !== 443) n += 10;
  if (!s.isManual) n += 1;
  return n;
}
