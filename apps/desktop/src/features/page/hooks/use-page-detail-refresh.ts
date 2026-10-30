import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PageSchemaResult } from "@/features/properties";
import { listenPageSourceEvents } from "../api/page-source-events-api";
import { isReadmeMissingError } from "../lib/readme-state";
import { watchOwnPathChange } from "../model/own-path-change";
import {
  isPageAncestorEvent,
  isPageSchemaEvent,
  isPageSourceEvent,
  mergeExternalPageMeta,
} from "../model/external-refresh";
import type { Page } from "../model";

interface PageDetailRefreshOptions {
  spacePath: string;
  /** Path of the shown Page; null while it is loading, missing or failed. */
  path: string | null;
  readSource: (path: string) => Promise<Page>;
  readSchema: (path: string) => Promise<PageSchemaResult | null>;
  /** Fields with a draft, pending or in-flight save. */
  localFields: () => Iterable<string>;
  applyPage: (path: string, update: (current: Page) => Page) => void;
  applySchema: (
    update: (current: PageSchemaResult | null) => PageSchemaResult | null,
  ) => void;
  /**
   * Resolves once this session's own saves and path changes and the
   * structural operations of this Desktop over the Space have finished.
   */
  settled: () => Promise<void>;
  /**
   * The Page file stopped existing outside this session; `changedHere` when
   * a deletion, rename or move started in this Desktop left its path.
   */
  onGone: (changedHere: boolean) => void;
  /**
   * Follows a folder above the Page that this Desktop renames or moves: saves
   * the pending work before, and takes the Page to its new path after.
   */
  relocation?: {
    prepare: () => Promise<unknown>;
    follow: (path: string) => void;
  };
}

/**
 * Keeps the shown Page metadata and schema in line with the files when
 * another writer changes them, and reports the Page when its file is gone or
 * a folder above it moved here. The editor reconciles the body on its own.
 */
export function usePageDetailRefresh(options: PageDetailRefreshOptions) {
  const { spacePath, path } = options;
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  // A field with local work at any point of a read keeps its local value: the
  // read may predate that write, and the echo of the write brings the file.
  const writesRef = useRef({ clock: 0, fields: new Map<string, number>() });
  const markLocalWrite = useCallback((field: string) => {
    const writes = writesRef.current;
    writes.clock += 1;
    writes.fields.set(field, writes.clock);
  }, []);

  useEffect(() => {
    if (!path) return;
    let active = true;
    let lastPageRead = 0;
    let appliedPageRead = 0;
    let lastSchemaRead = 0;
    let appliedSchemaRead = 0;
    // An own deletion of a directory Page reaches no watcher event, so its
    // end checks the Page as an event would.
    const ownChange = watchOwnPathChange(spacePath, path, {
      onDeleted: () => void refreshPage().catch(warn),
      follower: {
        prepare: async () => optionsRef.current.relocation?.prepare(),
        follow: (next) => {
          const relocation = optionsRef.current.relocation;
          if (!relocation) return;
          // The Page goes on at its new path, so nothing tells this one gone.
          active = false;
          relocation.follow(next);
        },
      },
    });

    const refreshPage = async (confirmingGone = false): Promise<void> => {
      const read = ++lastPageRead;
      const since = writesRef.current.clock;
      const local = new Set(optionsRef.current.localFields());
      let source: Page;
      try {
        source = await optionsRef.current.readSource(path);
      } catch (error) {
        if (!isReadmeMissingError(error, path)) throw error;
        if (!active || read < appliedPageRead) return;
        if (confirmingGone) {
          appliedPageRead = read;
          active = false;
          optionsRef.current.onGone(ownChange.changedHere());
          return;
        }
        // An own rename, move or conversion of the Page or of a folder above
        // it leaves this path too, so only its end tells the outcome; a
        // handoff of the Page or its move with the folder has retired this
        // subscription by then.
        await optionsRef.current.settled();
        if (active) return refreshPage(true);
        return;
      }
      if (!active || read < appliedPageRead) return;
      appliedPageRead = read;
      for (const field of optionsRef.current.localFields()) local.add(field);
      for (const [field, stamp] of writesRef.current.fields)
        if (stamp > since) local.add(field);
      optionsRef.current.applyPage(path, (current) =>
        mergeExternalPageMeta(current, source, local),
      );
    };
    const refreshSchema = async () => {
      const read = ++lastSchemaRead;
      const next = await optionsRef.current.readSchema(path);
      if (!active || read < appliedSchemaRead) return;
      appliedSchemaRead = read;
      optionsRef.current.applySchema((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    };
    const warn = (error: unknown) =>
      console.warn("Failed to refresh the Page detail:", error);

    const unlisten = listenPageSourceEvents({
      spacePath,
      onEvent: (eventPath) => {
        if (
          isPageSourceEvent(eventPath, path) ||
          isPageAncestorEvent(eventPath, path)
        )
          void refreshPage().catch(warn);
        else if (isPageSchemaEvent(eventPath, path))
          void refreshSchema().catch(warn);
      },
    });
    return () => {
      active = false;
      ownChange.stop();
      void unlisten.then((stop) => stop());
    };
  }, [path, spacePath]);

  return { markLocalWrite };
}
