/**
 * Runs a single eSCL scan job to completion.
 *
 * The job lifecycle is: POST /ScanJobs -> 201 + Location, then GET
 * NextDocument repeatedly. Each 200 is one side of one sheet; a 404 means the
 * job is finished. That loop is what makes ADF batch scanning work — the
 * device keeps handing back pages until the feeder runs dry.
 */

import { buildScanSettings, type ScanRequest } from "./escl";
import { esclFetch, helperUrl } from "./helper";

export type ScannedImage = {
  blob: Blob;
  /** 1-based position within this job. */
  indexInJob: number;
};

export type ScanJobEvents = {
  onJobCreated?: (jobPath: string) => void;
  onPage?: (page: ScannedImage) => void;
  onProgress?: (pagesSoFar: number) => void;
};

export class ScanError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ScanError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeCreateFailure(status: number): string {
  switch (status) {
    case 409:
      return "De scanner is bezig of de documentinvoer is leeg.";
    case 503:
      return "De scanner start op of is in gebruik. Probeer het zo meteen opnieuw.";
    case 404:
      return "De scanner heeft de opdracht niet geaccepteerd. Mogelijk ondersteunt hij scannen via het netwerk niet.";
    default:
      return `De scanner heeft de scanopdracht geweigerd (HTTP ${status}).`;
  }
}

export async function runScanJob(
  scannerId: string,
  req: ScanRequest,
  events: ScanJobEvents = {},
  signal?: AbortSignal,
): Promise<ScannedImage[]> {
  const create = await esclFetch(scannerId, "/ScanJobs", {
    method: "POST",
    headers: { "content-type": "text/xml" },
    body: buildScanSettings(req),
    signal,
  });

  if (create.status !== 201) {
    throw new ScanError(describeCreateFailure(create.status), create.status);
  }

  // The helper rewrites Location to a helper-relative path. Some browsers hide
  // `location` on cross-origin responses, so the helper mirrors it too.
  const jobPath = create.headers.get("x-escl-location") ?? create.headers.get("location");
  if (!jobPath) throw new ScanError("De scanner accepteerde de opdracht maar gaf geen opdracht-URL terug.");
  events.onJobCreated?.(jobPath);

  const pages: ScannedImage[] = [];
  const nextDocumentUrl = helperUrl(`${jobPath}/NextDocument`);

  // Guard against a device that never returns 404 — one sheet per iteration,
  // well above the 7740's 35-sheet feeder even when duplexing.
  const MAX_PAGES = 400;

  try {
    while (pages.length < MAX_PAGES) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      const res = await fetch(nextDocumentUrl, { signal });

      if (res.status === 404) break; // job complete — the normal exit

      if (res.status === 503) {
        // Device is mid-sheet; eSCL says back off and retry.
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await sleep(Math.min(retryAfter, 5) * 1000);
        continue;
      }

      if (!res.ok) {
        throw new ScanError(`De scanner gaf een fout tijdens het versturen van een pagina (HTTP ${res.status}).`, res.status);
      }

      const blob = await res.blob();
      if (blob.size === 0) break; // empty body is another end-of-job signal

      const page: ScannedImage = { blob, indexInJob: pages.length + 1 };
      pages.push(page);
      events.onPage?.(page);
      events.onProgress?.(pages.length);
    }
  } catch (err) {
    if ((err as Error)?.name === "AbortError") {
      // Politely tell the device to stop feeding paper.
      void fetch(helperUrl(jobPath), { method: "DELETE" }).catch(() => {});
    }
    throw err;
  }

  return pages;
}
