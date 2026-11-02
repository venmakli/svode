import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExternalOpenBinding } from "@/features/external-open";

import {
  documentExternalOpenTarget,
  loadDocumentBytes,
  loadDocumentDescriptor,
} from "../api/document-api";
import {
  type DocumentFailure,
  type DocumentSourceDescriptor,
  type DocumentTarget,
} from "../model/types";
import {
  HtmlDocumentError,
  revokeDocumentPage,
  serveDocumentPage,
  setDocumentPageTheme,
  subscribeDocumentPageChanges,
  type HtmlDocumentFailure,
  type HtmlTheme,
} from "./html-document-api";

/** The largest source shown in «Исходник». */
export const HTML_SOURCE_LIMIT_BYTES = 2_000_000;

export type HtmlDocumentState =
  | { phase: "serving" }
  | {
      phase: "ready";
      viewportUrl: string;
      /** A new value loads the page again. */
      revision: number;
    }
  | { phase: "failed"; failure: HtmlDocumentFailure };

/**
 * One serving of the HTML file while the surface shows it: its own origin,
 * loaded again when a file of its root or the Svode theme changes, revoked
 * when the surface closes. A surface that names another file is another
 * instance, keyed by `documentTargetKey`.
 */
export function useHtmlDocument(stableTarget: DocumentTarget) {
  const theme = useEffectiveTheme();
  const themeRef = useRef(theme);
  const tokenRef = useRef<string | null>(null);
  const [state, setState] = useState<HtmlDocumentState>({ phase: "serving" });
  const [source, setSource] = useState<DocumentSourceDescriptor | null>(null);
  const [externalOpenError, setExternalOpenError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const fail = (error: unknown) => {
      if (cancelled) return;
      setSource(null);
      setState({ phase: "failed", failure: failureOf(error) });
    };
    // The facts of the file, for ⓘ and the source; a missing or refused
    // file replaces the page.
    const inspect = async () => {
      const descriptor = await loadDocumentDescriptor(stableTarget);
      if (!cancelled) setSource(descriptor);
    };

    void (async () => {
      try {
        const servedTheme = themeRef.current;
        const serving = await serveDocumentPage(stableTarget, servedTheme);
        if (cancelled) {
          revokeDocumentPage(serving.capabilityToken);
          return;
        }
        tokenRef.current = serving.capabilityToken;
        if (themeRef.current !== servedTheme) {
          await setDocumentPageTheme(serving.capabilityToken, themeRef.current);
        }
        setState({
          phase: "ready",
          viewportUrl: serving.viewportUrl,
          revision: 0,
        });
        const stop = await subscribeDocumentPageChanges(
          serving.capabilityToken,
          () => {
            void inspect().then(() => {
              if (cancelled) return;
              // A file that is back shows its page again.
              setState((current) =>
                current.phase === "ready"
                  ? { ...current, revision: current.revision + 1 }
                  : {
                      phase: "ready",
                      viewportUrl: serving.viewportUrl,
                      revision: 0,
                    },
              );
            }, fail);
          },
        );
        if (cancelled) stop();
        else unlisten = stop;
        await inspect();
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) revokeDocumentPage(token);
    };
  }, [stableTarget]);

  // The theme comes into the page on its next load.
  useEffect(() => {
    if (themeRef.current === theme) return;
    themeRef.current = theme;
    const token = tokenRef.current;
    if (!token) return;
    void setDocumentPageTheme(token, theme).then(() => {
      if (tokenRef.current !== token) return;
      setState((current) =>
        current.phase === "ready"
          ? { ...current, revision: current.revision + 1 }
          : current,
      );
    });
  }, [theme]);

  const reload = useCallback(() => {
    setState((current) =>
      current.phase === "ready"
        ? { ...current, revision: current.revision + 1 }
        : current,
    );
  }, []);

  const externalOpen = useMemo<ExternalOpenBinding>(
    () => ({
      target: documentExternalOpenTarget(stableTarget, () =>
        setExternalOpenError(null),
      ),
      onError: (error) => {
        console.error("Failed to open document externally:", error);
        setExternalOpenError("external_open_failed");
      },
    }),
    [stableTarget],
  );

  return {
    externalOpen,
    externalOpenError,
    reload,
    source,
    state,
  };
}

export type HtmlSourceState =
  | { phase: "loading" }
  | { phase: "ready"; text: string }
  | { phase: "too_large" }
  | { phase: "failed" };

/** The text of the file as it is on disk, read again when it changes. */
export function useHtmlSource(
  stableTarget: DocumentTarget,
  source: DocumentSourceDescriptor | null,
  refused: boolean,
) {
  const [read, setRead] = useState<{
    generation: string;
    state: HtmlSourceState;
  } | null>(null);
  const generation = source?.generation ?? null;
  const tooLarge =
    refused || (source !== null && source.sizeBytes > HTML_SOURCE_LIMIT_BYTES);

  useEffect(() => {
    if (tooLarge || generation === null) return;
    let cancelled = false;
    void loadDocumentBytes(stableTarget, generation).then(
      (bytes) => {
        if (cancelled) return;
        setRead({
          generation,
          state: { phase: "ready", text: new TextDecoder().decode(bytes) },
        });
      },
      () => {
        if (!cancelled) setRead({ generation, state: { phase: "failed" } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [generation, stableTarget, tooLarge]);

  if (tooLarge) return { phase: "too_large" } satisfies HtmlSourceState;
  return read !== null && read.generation === generation
    ? read.state
    : ({ phase: "loading" } satisfies HtmlSourceState);
}

/** The theme Svode shows now, as the class on the document element. */
function useEffectiveTheme(): HtmlTheme {
  const [theme, setTheme] = useState(readEffectiveTheme);
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(readEffectiveTheme()));
    observer.observe(root, { attributeFilter: ["class"], attributes: true });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function readEffectiveTheme(): HtmlTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function failureOf(error: unknown): HtmlDocumentFailure {
  if (error instanceof HtmlDocumentError) return error.failure;
  // The descriptor reports the failures of other Documents.
  const kind = (error as Partial<DocumentFailure> | null)?.kind;
  if (kind === "source_missing") return { kind: "missing" };
  if (kind === "resource_limit") {
    return { kind: "refused", reason: "resource_limit" };
  }
  return { kind: "refused", reason: "source_inaccessible" };
}
