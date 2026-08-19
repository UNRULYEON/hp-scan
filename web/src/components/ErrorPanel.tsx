import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { formatThrown, type DisplayedError } from "../lib/appError";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // Clipboard can be denied; the dump is still on screen to select.
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="shrink-0 text-xs font-medium underline-offset-2 hover:underline"
    >
      {copied ? "Gekopieerd" : "Kopiëren"}
    </button>
  );
}

/** Always-visible dump so a screenshot or copy includes the real error. */
export function TechnicalDetails({
  detail,
  copyText,
}: {
  detail: string;
  copyText?: string;
}) {
  return (
    <div className="mt-3 rounded-md border border-red-200/80 bg-white/70 p-3 text-red-950">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-red-800">
          Technische details
        </p>
        <CopyButton text={copyText ?? detail} />
      </div>
      <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed">
        {detail}
      </pre>
    </div>
  );
}

export function ErrorBanner({
  error,
  description,
  onDismiss,
  dismissLabel = "Sluiten",
  onRetry,
  retryBusy,
}: {
  error: DisplayedError;
  description?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  onRetry?: () => void;
  retryBusy?: boolean;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <p className="font-medium">{error.message}</p>
      {description && <div className="mt-1 text-sm leading-relaxed text-red-800/80">{description}</div>}
      {(onRetry || onDismiss) && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retryBusy}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-sky-700 disabled:bg-stone-400"
            >
              {retryBusy ? "Bezig…" : "Opnieuw proberen"}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-md border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100"
            >
              {dismissLabel}
            </button>
          )}
        </div>
      )}
      <TechnicalDetails
        detail={error.detail}
        copyText={`${error.message}\n\n${error.detail}`}
      />
    </div>
  );
}

type BoundaryState = { error: DisplayedError | null };

/**
 * Last resort for render/lifecycle crashes. Without this the page goes blank
 * and the only clue is the browser console.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return {
      error: {
        message: "Er is iets misgegaan in de scanpagina. Vernieuw de pagina om opnieuw te beginnen.",
        detail: formatThrown(error),
      },
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const detail = [
      formatThrown(error),
      info.componentStack ? `Component stack:${info.componentStack}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    this.setState({
      error: {
        message: "Er is iets misgegaan in de scanpagina. Vernieuw de pagina om opnieuw te beginnen.",
        detail,
      },
    });
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6 p-6">
        <ErrorBanner
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
          onDismiss={() => location.reload()}
          dismissLabel="Pagina vernieuwen"
        />
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Scannen</h1>
        </header>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-white/60 p-16 text-center">
          <p className="text-lg font-medium text-stone-700">De pagina is vastgelopen</p>
          <p className="max-w-sm text-sm text-stone-500">
            Probeer het opnieuw, of vernieuw de pagina als de fout blijft terugkomen.
          </p>
        </div>
      </div>
    );
  }
}
