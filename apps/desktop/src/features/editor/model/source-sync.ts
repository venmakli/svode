import {
  pageSourceErrorKind,
  type Page,
  type PageSourceConflict,
  type WritePageResult,
} from "@/features/page";

import type { DocumentSourceBaseline } from "./plate-document-cache";

/** Editor effects the source sync drives; the host owns the Plate value and writes. */
export interface SourceSyncHost {
  baseline(path: string): DocumentSourceBaseline | null;
  setBaseline(path: string, baseline: DocumentSourceBaseline): void;
  /** True while the editor holds text that is not written yet. */
  hasDraft(path: string): boolean;
  whenWritesSettled(): Promise<void>;
  /** A fresh read of the source with its version. */
  readSource(path: string): Promise<Page>;
  /** Replaces the editor value and baseline with the source. */
  loadSource(path: string, page: Page): void;
  /** Adopts the metadata of a source whose body is still the edited baseline. */
  adoptMetadata(page: Page): void;
  /** Writes the current editor text as the body, from `sourceVersion`. */
  writeDraft(
    path: string,
    sourceVersion: string,
  ): Promise<WritePageResult | null>;
  setAutoSavePaused(paused: boolean): void;
  report(conflict: PageSourceConflict | null): void;
  onResolved(choice: "written" | "loaded"): void;
}

export type SourceReconcileOutcome =
  | "current"
  | "reloaded"
  | "rebased"
  | "conflict";

interface OpenConflict {
  path: string;
  page: Page | null;
  status: PageSourceConflict["status"];
  pending: PageSourceConflict["pending"];
  failure: PageSourceConflict["failure"];
}

/**
 * Keeps an editor's body draft consistent with its source file. A source that
 * changed under a draft is a conflict the user resolves explicitly, unless the
 * body the draft was edited from is unchanged, e.g. after a metadata save:
 * then the draft is still the intent applied to the current source.
 */
export function createSourceSync(host: SourceSyncHost) {
  let open: OpenConflict | null = null;

  function publish() {
    const conflict = open;
    if (!conflict) {
      host.report(null);
      return;
    }
    host.report({
      status: conflict.status,
      pending: conflict.pending,
      failure: conflict.failure,
      writeDraft: () => void writeDraft(conflict),
      loadFile: () => void loadFile(conflict),
      retryRead: () => void readFresh(conflict),
    });
  }

  function openConflict(path: string, page: Page | null) {
    host.setAutoSavePaused(true);
    open = {
      path,
      page,
      status: page?.source_version ? "ready" : "read_failed",
      pending: null,
      failure: null,
    };
    publish();
  }

  function close(choice: "written" | "loaded") {
    open = null;
    host.setAutoSavePaused(false);
    publish();
    host.onResolved(choice);
  }

  async function readFresh(conflict: OpenConflict) {
    if (open !== conflict || conflict.pending) return;
    conflict.status = "reading";
    publish();
    try {
      const page = await host.readSource(conflict.path);
      if (open !== conflict) return;
      conflict.page = page;
      conflict.status = page.source_version ? "ready" : "read_failed";
    } catch {
      if (open !== conflict) return;
      conflict.status = "read_failed";
    }
    publish();
  }

  async function writeDraft(conflict: OpenConflict) {
    const version = conflict.page?.source_version;
    if (open !== conflict || conflict.pending || !version) return;
    conflict.pending = "write";
    conflict.failure = null;
    publish();
    try {
      const result = await host.writeDraft(conflict.path, version);
      if (open !== conflict) return;
      if (result) {
        close("written");
        return;
      }
      conflict.pending = null;
      conflict.failure = "write";
      publish();
    } catch (error) {
      if (open !== conflict) return;
      conflict.pending = null;
      if (pageSourceErrorKind(error) === "source_stale") {
        conflict.failure = "changed_again";
        await readFresh(conflict);
        return;
      }
      conflict.failure = "write";
      publish();
    }
  }

  async function loadFile(conflict: OpenConflict) {
    if (open !== conflict || conflict.pending) return;
    conflict.pending = "load";
    conflict.failure = null;
    publish();
    try {
      const page = await host.readSource(conflict.path);
      if (open !== conflict) return;
      host.loadSource(conflict.path, page);
      close("loaded");
    } catch {
      if (open !== conflict) return;
      conflict.pending = null;
      conflict.failure = "load";
      publish();
    }
  }

  /**
   * Compares the source with the editor baseline after a stale write or an
   * external change. `rebase: false` treats any body-preserving change as a
   * conflict too, which bounds repeated stale retries.
   */
  async function reconcile(
    path: string,
    reason: "stale" | "external",
    { rebase = true }: { rebase?: boolean } = {},
  ): Promise<SourceReconcileOutcome> {
    if (open) return "conflict";
    if (reason === "external") await host.whenWritesSettled();
    if (open) return "conflict";
    let page: Page;
    try {
      page = await host.readSource(path);
    } catch (error) {
      if (open) return "conflict";
      if (reason === "external" && !host.hasDraft(path)) throw error;
      openConflict(path, null);
      return "conflict";
    }
    if (open) return "conflict";
    const baseline = host.baseline(path);
    const version = page.source_version ?? null;
    if (reason === "external") {
      if (version && baseline?.version === version) return "current";
      if (!host.hasDraft(path)) {
        host.loadSource(path, page);
        return "reloaded";
      }
    }
    if (rebase && version && baseline?.body === page.body) {
      host.setBaseline(path, { version, body: page.body });
      host.adoptMetadata(page);
      return "rebased";
    }
    openConflict(path, page);
    return "conflict";
  }

  return {
    reconcile,
    isOpen: () => open !== null,
    dispose() {
      if (!open) return;
      open = null;
      host.report(null);
    },
  };
}

export type SourceSync = ReturnType<typeof createSourceSync>;

/** Delays before re-trying a write another Svode process briefly holds. */
const SOURCE_BUSY_RETRY_DELAYS_MS = [300, 1000];

/**
 * Retries a write refused as busy after short delays with a fresh
 * precondition check each time; the last refusal reaches the caller.
 */
export async function retryWhileSourceBusy<Result>(
  write: () => Promise<Result>,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<Result> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await write();
    } catch (error) {
      const delay = SOURCE_BUSY_RETRY_DELAYS_MS[attempt];
      if (pageSourceErrorKind(error) !== "source_busy" || delay === undefined)
        throw error;
      await wait(delay);
    }
  }
}
