/**
 * A body draft that could not be written because the Page source changed
 * after the editor read it. The editor owns the draft and the actions; the
 * Page surface presents the choice and keeps navigation from dropping it.
 */
export interface PageSourceConflict {
  /** `reading` until a fresh read of the source gives the baseline to choose against. */
  status: "reading" | "ready" | "read_failed";
  pending: "write" | "load" | null;
  failure: "write" | "load" | "changed_again" | null;
  writeDraft(): void;
  loadFile(): void;
  retryRead(): void;
}

export type PageSourceErrorKind = "source_busy" | "source_stale";

export function pageSourceErrorKind(
  error: unknown,
): PageSourceErrorKind | null {
  const value =
    error instanceof Error
      ? ((error as Error & { cause?: unknown }).cause ?? error)
      : error;
  if (!value || typeof value !== "object") return null;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "source_busy" || kind === "source_stale" ? kind : null;
}
