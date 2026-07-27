import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PAPER_SIZES,
  capsForRequest,
  parseCapabilities,
  parseStatus,
  type Capabilities,
  type ColorMode,
  type InputSource,
  type ScannerStatus,
} from "./lib/escl";
import {
  HelperUnavailableError,
  addManualScanner,
  removeScanner,
  checkHelper,
  esclFetch,
  listScanners,
  type Scanner,
} from "./lib/helper";
import { runScanJob } from "./lib/scanJob";
import { buildPdf, downloadBlob, sanitizeFilename } from "./lib/pdf";
import { PageGrid } from "./components/PageGrid";
import { PrinterList } from "./components/PrinterList";
import type { ScanPage } from "./types";

const COLOR_LABELS: Record<ColorMode, string> = {
  RGB24: "Kleur",
  Grayscale8: "Grijstinten",
  BlackAndWhite1: "Zwart-wit",
};

function defaultFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Scan ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function App() {
  // --- connection ---------------------------------------------------------
  const [helperReady, setHelperReady] = useState<boolean | null>(null);
  const [scanners, setScanners] = useState<Scanner[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [status, setStatus] = useState<ScannerStatus | null>(null);

  // --- scan settings ------------------------------------------------------
  const [source, setSource] = useState<InputSource>("Platen");
  const [duplex, setDuplex] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>("RGB24");
  const [resolution, setResolution] = useState(300);
  const [paperId, setPaperId] = useState("a4");

  // --- document -----------------------------------------------------------
  const [pages, setPages] = useState<ScanPage[]>([]);
  const [filename, setFilename] = useState(defaultFilename);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const selected = useMemo(
    () => scanners.find((s) => s.id === selectedId) ?? null,
    [scanners, selectedId],
  );
  const paper = PAPER_SIZES.find((p) => p.id === paperId) ?? PAPER_SIZES[0];
  const activeCaps = caps ? capsForRequest(caps, source, duplex) : undefined;
  const hasFeeder = Boolean(caps?.adfSimplex || caps?.adfDuplex);
  const supportsDuplex = Boolean(caps?.adfDuplex);

  // --- helper + discovery -------------------------------------------------

  const refreshScanners = useCallback(async () => {
    try {
      const found = await listScanners();
      setScanners(found);
      setSelectedId((current) => current ?? found[0]?.id ?? null);
    } catch (err) {
      if (err instanceof HelperUnavailableError) setHelperReady(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await checkHelper();
        if (cancelled) return;
        setHelperReady(true);
        await refreshScanners();
      } catch {
        if (!cancelled) setHelperReady(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshScanners]);

  // Printers drop off and rejoin the network constantly; keep the list warm.
  useEffect(() => {
    if (!helperReady) return;
    const t = setInterval(refreshScanners, 15_000);
    return () => clearInterval(t);
  }, [helperReady, refreshScanners]);

  // Load capabilities whenever the chosen scanner changes.
  useEffect(() => {
    if (!selectedId) {
      setCaps(null);
      return;
    }
    // Drop the previous printer's details straight away, so an unreachable one
    // never shows the last printer's settings and a stale "Gereed" badge.
    setCaps(null);
    setStatus(null);

    let cancelled = false;
    (async () => {
      try {
        // The proxy's own timeout is sized for scan jobs, which take minutes.
        // Probing must fail fast instead, or a dead address hangs the UI.
        const res = await esclFetch(selectedId, "/ScannerCapabilities", {
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseCapabilities(await res.text());
        if (cancelled) return;
        setCaps(parsed);
        setError(null);

        // Snap the settings onto something this device actually supports.
        const initial = parsed.platen ?? parsed.adfSimplex ?? parsed.adfDuplex;
        if (initial) {
          setResolution((r) =>
            initial.resolutions.includes(r)
              ? r
              : (initial.resolutions.find((x) => x >= 300) ?? initial.resolutions.at(-1) ?? 300),
          );
          setColorMode((c) => (initial.colorModes.includes(c) ? c : initial.colorModes[0]));
        }
        if (!parsed.platen && (parsed.adfSimplex || parsed.adfDuplex)) setSource("Feeder");
      } catch (err) {
        if (!cancelled) {
          setCaps(null);
          const timedOut = (err as Error).name === "TimeoutError";
          setError(
            timedOut
              ? `Geen reactie van de printer. Controleer of hij aan staat en of het adres klopt.`
              : `Kan de mogelijkheden van de printer niet uitlezen (${(err as Error).message}). ` +
                `Mogelijk staat hij in slaapstand — wek hem en probeer opnieuw.`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  // Poll status so the ADF indicator reflects reality, but not while scanning
  // (the device is busy and polling can stall the job).
  useEffect(() => {
    if (!selectedId || scanning) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await esclFetch(selectedId, "/ScannerStatus", {
          signal: AbortSignal.timeout(8_000),
        });
        if (res.ok && !cancelled) setStatus(parseStatus(await res.text()));
      } catch {
        /* transient; the next tick will retry */
      }
    };
    void poll();
    const t = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [selectedId, scanning]);

  // --- actions ------------------------------------------------------------
  // Object URLs are revoked in deletePage/clearAll, which are the only paths
  // that drop a page while the app is alive.

  async function handleScan() {
    if (!selectedId) return;
    setError(null);
    setScanning(true);
    setProgress(0);

    const controller = new AbortController();
    abortRef.current = controller;

    const width = Math.min(paper.width, activeCaps?.maxWidth ?? paper.width);
    const height = Math.min(paper.height, activeCaps?.maxHeight ?? paper.height);

    try {
      await runScanJob(
        selectedId,
        { source, duplex: source === "Feeder" && duplex, colorMode, resolution, width, height },
        {
          onPage: (page) => {
            // Append as each sheet arrives so the user sees progress live.
            setPages((prev) => [
              ...prev,
              {
                id: crypto.randomUUID(),
                blob: page.blob,
                url: URL.createObjectURL(page.blob),
                rotation: 0,
                widthUnits: width,
                heightUnits: height,
              },
            ]);
          },
          onProgress: setProgress,
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setScanning(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function rotatePage(id: string, delta: 90 | -90) {
    setPages((prev) =>
      prev.map((p) =>
        p.id === id
          ? { ...p, rotation: (((p.rotation + delta) % 360) + 360) % 360 as ScanPage["rotation"] }
          : p,
      ),
    );
  }

  function deletePage(id: string) {
    setPages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
  }

  function clearAll() {
    setPages((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const pdf = await buildPdf(
        pages.map((p) => ({
          blob: p.blob,
          rotation: p.rotation,
          widthUnits: p.widthUnits,
          heightUnits: p.heightUnits,
        })),
        { title: filename },
      );
      downloadBlob(pdf, sanitizeFilename(filename));
    } catch (err) {
      setError(`Kan de PDF niet maken: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleAddManual(host: string) {
    try {
      const s = await addManualScanner(host);
      await refreshScanners();
      // Switch to what was just added — that's why they added it.
      setSelectedId(s.id);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleRemoveScanner(id: string) {
    try {
      await removeScanner(id);
      // Drop the selection so the next discovered scanner is picked up, rather
      // than leaving the UI pointing at an id the helper no longer knows.
      setSelectedId(null);
      setCaps(null);
      setStatus(null);
      setError(null);
      await refreshScanners();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const previewPage = pages.find((p) => p.id === previewId) ?? null;

  // --- render -------------------------------------------------------------

  if (helperReady === false) return <HelperMissing onRetry={() => location.reload()} />;

  return (
    <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scannen</h1>
          <p className="text-sm text-stone-500">
            {!selected
              ? "Bezig met zoeken naar printers op je netwerk…"
              : selected.isManual
                ? // A manual entry has no model to report, only an address.
                  `Handmatige printer op ${selected.host}`
                : `${selected.model}${selected.isSimulator ? " (simulator)" : ""}`}
          </p>
        </div>
        <StatusPill status={status} caps={caps} />
      </header>

      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <aside className="flex flex-col gap-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
          <PrinterList
            scanners={scanners}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRemove={handleRemoveScanner}
            onAdd={handleAddManual}
          />

          <Field label="Scannen vanaf">
            <div className="grid grid-cols-2 gap-2">
              <Segmented
                active={source === "Platen"}
                disabled={!caps?.platen}
                onClick={() => setSource("Platen")}
              >
                Glasplaat
              </Segmented>
              <Segmented
                active={source === "Feeder"}
                disabled={!hasFeeder}
                onClick={() => setSource("Feeder")}
              >
                Invoer
              </Segmented>
            </div>
            {source === "Feeder" && supportsDuplex && (
              <label className="mt-3 flex items-center gap-2 text-sm text-stone-700">
                <input
                  type="checkbox"
                  checked={duplex}
                  onChange={(e) => setDuplex(e.target.checked)}
                  className="size-4 rounded border-stone-300"
                />
                Beide zijden scannen
              </label>
            )}
          </Field>

          <Field label="Kleur">
            <select
              value={colorMode}
              onChange={(e) => setColorMode(e.target.value as ColorMode)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            >
              {(activeCaps?.colorModes ?? ["RGB24"]).map((m) => (
                <option key={m} value={m}>
                  {COLOR_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Kwaliteit">
            <select
              value={resolution}
              onChange={(e) => setResolution(Number(e.target.value))}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            >
              {(activeCaps?.resolutions ?? [300]).map((r) => (
                <option key={r} value={r}>
                  {r} dpi{r === 300 ? " — aanbevolen" : ""}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Paginaformaat">
            <select
              value={paperId}
              onChange={(e) => setPaperId(e.target.value)}
              className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm"
            >
              {PAPER_SIZES.filter(
                (p) => !activeCaps || p.width <= activeCaps.maxWidth + 8,
              ).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>

          {scanning ? (
            <button
              type="button"
              onClick={handleCancel}
              className="rounded-md bg-stone-800 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-900"
            >
              Stoppen — {progress} pagina{progress === 1 ? "" : "'s"} tot nu toe
            </button>
          ) : (
            <button
              type="button"
              onClick={handleScan}
              disabled={!selectedId || !caps}
              className="rounded-md bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {pages.length === 0 ? "Scannen" : "Meer pagina's scannen"}
            </button>
          )}

          {source === "Feeder" && status && !status.adfLoaded && caps?.detectsPaperLoaded && (
            <p className="-mt-2 text-xs text-amber-700">Leg eerst je documenten in de invoer.</p>
          )}
        </aside>

        <main className="flex flex-col gap-4">
          {error && (
            <div className="flex items-start justify-between gap-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)} className="font-medium">
                Sluiten
              </button>
            </div>
          )}

          {pages.length === 0 ? (
            <EmptyState scanning={scanning} source={source} />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <input
                    value={filename}
                    onChange={(e) => setFilename(e.target.value)}
                    aria-label="Bestandsnaam"
                    className="min-w-0 flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
                  />
                  <span className="hidden shrink-0 text-sm text-stone-400 sm:inline">.pdf</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-stone-500">
                    {pages.length} pagina{pages.length === 1 ? "" : "'s"}
                  </span>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="rounded-md border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-50"
                  >
                    Wissen
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="rounded-md bg-stone-900 px-4 py-2 text-sm font-semibold text-white hover:bg-black disabled:bg-stone-400"
                  >
                    {saving ? "Bezig…" : "PDF downloaden"}
                  </button>
                </div>
              </div>

              <PageGrid
                pages={pages}
                onReorder={setPages}
                onRotate={rotatePage}
                onDelete={deletePage}
                onPreview={setPreviewId}
              />
            </>
          )}
        </main>
      </div>

      {previewPage && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setPreviewId(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
        >
          <img
            src={previewPage.url}
            alt="Pagina op volledig formaat"
            style={{ transform: `rotate(${previewPage.rotation}deg)` }}
            className="max-h-full max-w-full rounded shadow-2xl"
          />
        </div>
      )}
    </div>
  );
}

// --- small presentational pieces -------------------------------------------

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-stone-500">
        {label}
      </span>
      {children}
    </div>
  );
}

function Segmented({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? "border-sky-600 bg-sky-50 text-sky-800"
          : "border-stone-300 text-stone-700 hover:bg-stone-50"
      } disabled:cursor-not-allowed disabled:border-stone-200 disabled:text-stone-300 disabled:hover:bg-transparent`}
    >
      {children}
    </button>
  );
}

function StatusPill({ status, caps }: { status: ScannerStatus | null; caps: Capabilities | null }) {
  if (!caps) return null;
  const busy = status?.state === "Processing";
  return (
    <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium shadow-sm">
      <span className={`size-2 rounded-full ${busy ? "bg-amber-500" : "bg-emerald-500"}`} />
      {busy ? "Bezig" : "Gereed"}
      {caps.detectsPaperLoaded && status?.adfLoaded && (
        <span className="text-stone-500">· papier in invoer</span>
      )}
    </div>
  );
}

function EmptyState({ scanning, source }: { scanning: boolean; source: InputSource }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-white/60 p-16 text-center">
      <p className="text-lg font-medium text-stone-700">
        {scanning ? "Bezig met scannen…" : "Nog geen pagina's"}
      </p>
      <p className="max-w-sm text-sm text-stone-500">
        {scanning
          ? "Pagina's verschijnen hier zodra ze uit de scanner komen."
          : source === "Feeder"
            ? "Leg je documenten in de invoer en klik op Scannen."
            : "Leg een pagina op de glasplaat en klik op Scannen. Je kunt pagina voor pagina blijven toevoegen."}
      </p>
    </div>
  );
}

function HelperMissing({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex min-h-full items-center justify-center p-8">
      <div className="max-w-lg rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <h1 className="text-xl font-semibold">De scanhelper draait niet</h1>
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          Deze pagina heeft een klein hulpprogramma op je computer nodig om je printer te vinden en
          ermee te communiceren. Browsers kunnen printers niet zelf bereiken.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-stone-600">
          Start <span className="font-medium">hp-scan-helper</span> en probeer het opnieuw.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-6 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
        >
          Opnieuw proberen
        </button>
      </div>
    </div>
  );
}
