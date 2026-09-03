import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadDocumentBytes,
  loadDocumentDescriptor,
  openDocumentInSystem,
  subscribeDocumentInvalidated,
} from "../api/document-api";
import {
  DocumentRuntimeSession,
  documentSessionCoordinator,
} from "../model/session";
import {
  DEFAULT_DOCUMENT_VIEW_STATE,
  documentHasInlinePreview,
  documentTargetKey,
  type DocumentFailure,
  type DocumentSessionState,
  type DocumentTarget,
  type DocumentViewState,
} from "../model/types";
import {
  DocxPasswordFailure,
  DocxRuntimeFailure,
  isDocxAbortError,
  openDocxDocument,
} from "../docx/docx-runtime";
import { extractDocxText } from "../docx/docx-text-index";
import {
  isAbortError,
  openPdfDocument,
  PdfRuntimeFailure,
} from "../pdf/pdf-runtime";
import { extractPdfText } from "../pdf/pdf-text-index";

let nextSessionId = 1;

export function useDocumentSession(target: DocumentTarget) {
  const { path, projectPath, spaceId, spacePath } = target;
  const stableTarget = useMemo(
    () => ({ path, projectPath, spaceId, spacePath }),
    [path, projectPath, spaceId, spacePath],
  );
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<DocumentSessionState>({
    phase: "loading",
    progress: 0,
  });
  const [viewState, setViewState] = useState<DocumentViewState>({
    ...DEFAULT_DOCUMENT_VIEW_STATE,
  });
  const [externalOpenError, setExternalOpenError] = useState<string | null>(
    null,
  );
  const sessionRef = useRef<DocumentRuntimeSession | null>(null);
  const targetKey = documentTargetKey(stableTarget);

  useEffect(() => {
    const session = new DocumentRuntimeSession(nextSessionId++, targetKey);
    sessionRef.current = session;
    setExternalOpenError(null);
    setState({ phase: "loading", progress: 0.05 });

    void (async () => {
      if (!(await documentSessionCoordinator.activate(session))) return;
      setViewState(session.getViewState());
      try {
        const descriptor = await loadDocumentDescriptor(stableTarget);
        if (session.signal.aborted) return;
        if (!documentHasInlinePreview(descriptor.format)) {
          setState({
            failure: { kind: "external_only" },
            phase: "failed",
          });
          return;
        }
        setState({ phase: "loading", progress: 0.25 });
        const bytes = await loadDocumentBytes(
          stableTarget,
          descriptor.generation,
        );
        if (session.signal.aborted) return;
        setState({ phase: "loading", progress: 0.35 });
        if (descriptor.format === "docx") {
          const loadDocx = async (password?: string) => {
            if (session.signal.aborted) return;
            setState({ phase: "loading", progress: 0.35 });
            try {
              const docx = await openDocxDocument({
                bytes,
                onLoading: (progress) => {
                  if (!session.signal.aborted) {
                    setState({ phase: "loading", progress });
                  }
                },
                password,
                session,
              });
              if (session.signal.aborted) return;
              session.setPasswordHandler(null);
              setState({
                descriptor,
                docx,
                format: "docx",
                phase: "ready",
                textIndex: extractDocxText(docx.document),
              });
            } catch (error) {
              if (session.signal.aborted || isDocxAbortError(error)) return;
              if (error instanceof DocxPasswordFailure) {
                setState({
                  format: "docx",
                  incorrect: error.incorrect,
                  phase: "password",
                });
                return;
              }
              setState({ failure: failureFromError(error), phase: "failed" });
            }
          };
          session.setPasswordHandler((password) => void loadDocx(password));
          await loadDocx();
          return;
        }

        const pdf = await openPdfDocument({
          bytes,
          onLoading: (progress) => {
            if (!session.signal.aborted) {
              setState({ phase: "loading", progress });
            }
          },
          onPassword: (incorrect) => {
            if (!session.signal.aborted) {
              setState({ format: "pdf", incorrect, phase: "password" });
            }
          },
          session,
        });
        if (session.signal.aborted) return;
        const initialIndex = { complete: false, pages: [], truncated: false };
        setState({
          descriptor,
          format: "pdf",
          pdf,
          phase: "ready",
          textIndex: initialIndex,
        });
        void extractPdfText(pdf, session.signal, (textIndex) => {
          if (session.signal.aborted) return;
          setState((current) =>
            current.phase === "ready" &&
            current.format === "pdf" &&
            current.pdf === pdf
              ? { ...current, textIndex }
              : current,
          );
        }).catch(() => undefined);
      } catch (error) {
        if (session.signal.aborted || isAbortError(error)) return;
        setState({ failure: failureFromError(error), phase: "failed" });
      }
    })();

    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      void documentSessionCoordinator.release(session);
    };
  }, [retryKey, stableTarget, targetKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeDocumentInvalidated(stableTarget, () => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      void documentSessionCoordinator.release(session);
      setState({ failure: { kind: "source_changed" }, phase: "failed" });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [stableTarget]);

  const updateViewState = useCallback(
    (
      update:
        | DocumentViewState
        | ((current: DocumentViewState) => DocumentViewState),
    ) => {
      setViewState((current) => {
        const next = typeof update === "function" ? update(current) : update;
        sessionRef.current?.setViewState(next);
        return next;
      });
    },
    [],
  );

  const openExternal = useCallback(async () => {
    setExternalOpenError(null);
    try {
      await openDocumentInSystem(stableTarget);
    } catch {
      setExternalOpenError("external_open_failed");
    }
  }, [stableTarget]);

  const prepareFullPageHandoff = useCallback(async () => {
    const session = sessionRef.current;
    if (session) {
      sessionRef.current = null;
      await documentSessionCoordinator.handoff(session);
    }
  }, []);

  const reportRendererError = useCallback((error: unknown) => {
    const session = sessionRef.current;
    if (session) {
      sessionRef.current = null;
      void documentSessionCoordinator.release(session);
    }
    setState({ failure: failureFromError(error), phase: "failed" });
  }, []);

  const registerRendererDisposer = useCallback((disposer: () => void) => {
    const session = sessionRef.current;
    if (!session) {
      disposer();
      return () => undefined;
    }
    return session.addDisposer(disposer);
  }, []);

  return {
    externalOpenError,
    openExternal,
    prepareFullPageHandoff,
    registerRendererDisposer,
    reportRendererError,
    retry: () => setRetryKey((key) => key + 1),
    state,
    submitPassword: (password: string) =>
      sessionRef.current?.submitPassword(password),
    updateViewState,
    viewState,
  };
}

export function failureFromError(error: unknown): DocumentFailure {
  if (error instanceof PdfRuntimeFailure) {
    return { detail: error.message, kind: error.kind };
  }
  if (error instanceof DocxRuntimeFailure) {
    return { detail: error.message, kind: error.kind };
  }
  if (isDocumentFailure(error)) return error;
  return {
    detail: error instanceof Error ? error.message : String(error),
    kind: "renderer_error",
  };
}

function isDocumentFailure(value: unknown): value is DocumentFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}
