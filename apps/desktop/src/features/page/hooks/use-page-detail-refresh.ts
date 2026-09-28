import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PageSchemaResult } from "@/features/properties";
import { listenPageSourceEvents } from "../api/page-source-events-api";
import {
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
}

/**
 * Keeps the shown Page metadata and schema in line with the files when
 * another writer changes them. The editor reconciles the body on its own.
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

    const refreshPage = async () => {
      const read = ++lastPageRead;
      const since = writesRef.current.clock;
      const local = new Set(optionsRef.current.localFields());
      const source = await optionsRef.current.readSource(path);
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
      onEvent: (eventPath, kind) => {
        if (kind !== "deleted" && isPageSourceEvent(eventPath, path))
          void refreshPage().catch(warn);
        else if (isPageSchemaEvent(eventPath, path))
          void refreshSchema().catch(warn);
      },
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [path, spacePath]);

  return { markLocalWrite };
}
