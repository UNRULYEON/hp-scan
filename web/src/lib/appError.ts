/**
 * Turns a thrown value into something the UI can show: a plain-language
 * description for the user, plus the raw error a technical person can copy.
 */

export type DisplayedError = {
  /** What went wrong, in plain language. */
  message: string;
  /** Name, message, status, cause chain, stack — whatever we can recover. */
  detail: string;
};

const MAX_BODY = 4_000;
const MAX_CAUSE_DEPTH = 5;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function extraLines(err: Error): string[] {
  const lines: string[] = [];
  const rec = asRecord(err);
  if (!rec) return lines;

  if (typeof rec.status === "number") lines.push(`HTTP status: ${rec.status}`);
  if (typeof rec.responseBody === "string" && rec.responseBody.trim()) {
    const body = rec.responseBody.trim();
    lines.push("Response body:", body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}\n…` : body);
  }
  if (typeof rec.componentStack === "string" && rec.componentStack.trim()) {
    lines.push("Component stack:", rec.componentStack.trim());
  }
  return lines;
}

function formatOne(err: unknown): string {
  if (err instanceof Error) {
    const header = err.message ? `${err.name}: ${err.message}` : err.name;
    const extras = extraLines(err);
    // Engines prefix stack with "Name: message"; skip that duplicate line.
    const stack = err.stack
      ?.split("\n")
      .filter((line, i) => i === 0 ? !line.startsWith(`${err.name}`) : true)
      .join("\n")
      .trim();
    return [header, ...extras, stack].filter(Boolean).join("\n");
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Flatten a thrown value (and its `cause` chain) into a copy-pasteable dump. */
export function formatThrown(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current != null && depth < MAX_CAUSE_DEPTH; depth++) {
    if (depth > 0) parts.push("Caused by:");
    parts.push(formatOne(current));
    const rec = asRecord(current);
    current = rec && "cause" in rec ? rec.cause : undefined;
  }
  return parts.join("\n");
}

export function toDisplayedError(err: unknown, message: string): DisplayedError {
  return { message, detail: formatThrown(err) };
}

/**
 * Errors whose `message` was written for humans (Dutch UI copy). Unknown
 * throws — TypeError, fetch failures, and the like — keep a context-specific
 * fallback so the headline stays readable.
 */
const USER_FACING_ERROR_NAMES = new Set([
  "ScanError",
  "HelperRequestError",
  "HelperUnavailableError",
]);

export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && USER_FACING_ERROR_NAMES.has(err.name) && err.message.trim()) {
    return err.message;
  }
  return fallback;
}
