import { useState } from "react";
import type { Scanner } from "../lib/helper";

/**
 * Printer management: pick one, see where it lives and how it got there,
 * add one by IP, remove the ones added that way.
 *
 * Discovered printers deliberately have no remove control — mDNS owns them and
 * would put them straight back, so offering one would be a lie.
 */

function addressLabel(s: Scanner): string {
  return s.port === 80 || s.port === 443 ? s.host : `${s.host}:${s.port}`;
}

function originLabel(s: Scanner): string {
  if (s.isManual) return "Handmatig toegevoegd";
  return s.isSimulator ? "Simulator op het netwerk" : "Gevonden op het netwerk";
}

type PrinterRowProps = {
  scanner: Scanner;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
};

function PrinterRow({ scanner, selected, onSelect, onRemove }: PrinterRowProps) {
  const address = addressLabel(scanner);
  // Manual entries are named after their address, so don't print it twice.
  const showAddress = !scanner.name.includes(scanner.host);

  return (
    <li
      className={`group relative flex items-start gap-2 border-b border-stone-100 last:border-b-0 ${
        selected ? "bg-sky-50/70" : "hover:bg-stone-50"
      }`}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected}
        className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          aria-hidden="true"
          className={`mt-1 size-2.5 shrink-0 rounded-full border-2 ${
            selected ? "border-sky-600 bg-sky-600" : "border-stone-300"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-1.5">
            <span
              className={`truncate text-sm ${selected ? "font-semibold text-sky-900" : "font-medium text-stone-800"}`}
            >
              {scanner.name}
            </span>
            {showAddress && (
              <span className="font-mono text-xs text-stone-500">{address}</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-stone-500">{originLabel(scanner)}</span>
        </span>
      </button>

      {scanner.isManual && (
        <button
          type="button"
          onClick={onRemove}
          title={`${scanner.name} verwijderen`}
          aria-label={`${scanner.name} verwijderen`}
          className="mr-1.5 mt-2 rounded p-1.5 text-stone-400 opacity-0 transition-opacity hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100"
        >
          <svg viewBox="0 0 20 20" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
            <path
              d="M4 6h12M8 6V4h4v2m-6 0 .7 9.1a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </li>
  );
}

type PrinterListProps = {
  scanners: Scanner[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (host: string) => Promise<void>;
};

export function PrinterList({
  scanners,
  selectedId,
  onSelect,
  onRemove,
  onAdd,
}: PrinterListProps) {
  const [adding, setAdding] = useState(false);
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const value = host.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      await onAdd(value);
      setHost("");
      setAdding(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-stone-500">
          Printers
        </span>
        {scanners.length > 0 && (
          <span className="text-xs text-stone-400">{scanners.length}</span>
        )}
      </div>

      <ul className="overflow-hidden rounded-md border border-stone-300 bg-white">
        {scanners.length === 0 ? (
          <li className="px-3 py-4 text-center text-xs text-stone-500">
            Bezig met zoeken naar printers op je netwerk…
          </li>
        ) : (
          scanners.map((s) => (
            <PrinterRow
              key={s.id}
              scanner={s}
              selected={s.id === selectedId}
              onSelect={() => onSelect(s.id)}
              onRemove={() => onRemove(s.id)}
            />
          ))
        )}
      </ul>

      {adding ? (
        <div className="mt-2">
          <div className="flex gap-2">
            <input
              value={host}
              onChange={(e) => setHost(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
                if (e.key === "Escape") setAdding(false);
              }}
              placeholder="Bijv. 192.168.1.50"
              autoFocus
              className="min-w-0 flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || !host.trim()}
              className="rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:bg-stone-300"
            >
              {busy ? "Bezig…" : "Toevoegen"}
            </button>
          </div>
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="mt-1.5 text-xs font-medium text-stone-500 hover:text-stone-800 hover:underline"
          >
            Annuleren
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="mt-2 flex items-center gap-1 text-xs font-medium text-sky-700 hover:text-sky-900 hover:underline"
        >
          <svg viewBox="0 0 20 20" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 5v10M5 10h10" strokeLinecap="round" />
          </svg>
          Printer toevoegen op IP-adres
        </button>
      )}
    </div>
  );
}
