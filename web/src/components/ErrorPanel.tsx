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
  onDismiss,
}: {
  error: DisplayedError;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-medium">{error.message}</p>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="shrink-0 font-medium">
            Sluiten
          </button>
        )}
      </div>
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
      <div className="flex min-h-full items-center justify-center p-8">
        <div className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-8 shadow-sm">
          <h1 className="text-xl font-semibold text-red-900">De pagina is vastgelopen</h1>
          <p className="mt-3 text-sm leading-relaxed text-stone-600">{this.state.error.message}</p>
          <TechnicalDetails detail={this.state.error.detail} />
          <button
            type="button"
            onClick={() => location.reload()}
            className="mt-6 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700"
          >
            Pagina vernieuwen
          </button>
        </div>
      </div>
    );
  }
}
