import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  checkMediaSource,
  loadMediaSource,
  openMediaInSystem,
  releaseMediaSource,
  subscribeMediaInvalidated,
} from "../api/media-api";
import { MediaRuntimeSession, mediaSessionCoordinator } from "../model/session";
import {
  DEFAULT_MEDIA_VIEW_STATE,
  mediaTargetKey,
  type MediaFailure,
  type MediaRuntimeMetadata,
  type MediaSessionState,
  type MediaSourceDescriptor,
  type MediaTarget,
  type MediaViewState,
} from "../model/types";

const MEDIA_LOAD_TIMEOUT_MS = 15_000;
let nextSessionId = 1;

export function useMediaSession(target: MediaTarget) {
  const { path, projectPath, spaceId, spacePath } = target;
  const stableTarget = useMemo(
    () => ({ path, projectPath, spaceId, spacePath }),
    [path, projectPath, spaceId, spacePath],
  );
  const targetKey = mediaTargetKey(stableTarget);
  const [retryKey, setRetryKey] = useState(0);
  const [state, setState] = useState<MediaSessionState>({
    phase: "resolving",
  });
  const [viewState, setViewState] = useState<MediaViewState>({
    ...DEFAULT_MEDIA_VIEW_STATE,
    playback: { ...DEFAULT_MEDIA_VIEW_STATE.playback },
  });
  const viewStateRef = useRef<MediaViewState>({
    ...DEFAULT_MEDIA_VIEW_STATE,
    playback: { ...DEFAULT_MEDIA_VIEW_STATE.playback },
  });
  const [externalOpenError, setExternalOpenError] = useState(false);
  const sessionRef = useRef<MediaRuntimeSession | null>(null);
  const sourceRef = useRef<MediaSourceDescriptor | null>(null);

  useEffect(() => {
    const session = new MediaRuntimeSession(nextSessionId++, targetKey);
    sessionRef.current = session;
    sourceRef.current = null;
    setExternalOpenError(false);
    setState({ phase: "resolving" });

    void (async () => {
      if (!(await mediaSessionCoordinator.activate(session))) return;
      const initialViewState = session.getViewState();
      viewStateRef.current = initialViewState;
      setViewState(initialViewState);
      try {
        const source = await loadMediaSource(stableTarget);
        if (session.signal.aborted) {
          await releaseMediaSource(source.capabilityToken);
          return;
        }
        session.addDisposer(() => releaseMediaSource(source.capabilityToken));
        if (source.family === "image" && !source.inlinePreview) {
          sessionRef.current = null;
          setState({
            failure: { kind: "external_only" },
            phase: "failed",
          });
          void mediaSessionCoordinator.release(session);
          return;
        }
        sourceRef.current = source;
        setState({ phase: "loading", source });
        session.setLoadTimeout(() => {
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          sourceRef.current = null;
          setState({
            failure: {
              kind:
                source.family !== "image" && source.requiresRangeRequests
                  ? "unusable_range"
                  : source.family === "image"
                    ? "runtime_error"
                    : "playback_error",
            },
            phase: "failed",
          });
          void mediaSessionCoordinator.release(session);
        }, MEDIA_LOAD_TIMEOUT_MS);
      } catch (error) {
        if (session.signal.aborted) return;
        sessionRef.current = null;
        setState({ failure: asMediaFailure(error), phase: "failed" });
        void mediaSessionCoordinator.release(session);
      }
    })();

    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      if (sourceRef.current?.capabilityToken) sourceRef.current = null;
      void mediaSessionCoordinator.release(session);
    };
  }, [retryKey, stableTarget, targetKey]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void subscribeMediaInvalidated(stableTarget, () => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      sourceRef.current = null;
      setState({ failure: { kind: "source_changed" }, phase: "failed" });
      void mediaSessionCoordinator.release(session);
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
      update: MediaViewState | ((current: MediaViewState) => MediaViewState),
    ) => {
      const next =
        typeof update === "function" ? update(viewStateRef.current) : update;
      viewStateRef.current = next;
      sessionRef.current?.setViewState(next);
      setViewState(next);
    },
    [],
  );

  const markReady = useCallback(
    (source: MediaSourceDescriptor, metadata?: MediaRuntimeMetadata) => {
      const session = sessionRef.current;
      if (
        !session ||
        session.signal.aborted ||
        sourceRef.current?.capabilityToken !== source.capabilityToken
      ) {
        return;
      }
      session.clearLoadTimeout();
      const readySource = metadata
        ? {
            ...source,
            durationSeconds: metadata.durationSeconds ?? source.durationSeconds,
            height: metadata.height ?? source.height,
            width: metadata.width ?? source.width,
          }
        : source;
      sourceRef.current = readySource;
      setState({ phase: "ready", source: readySource });
    },
    [],
  );

  const reportSourceFailure = useCallback(
    async (source: MediaSourceDescriptor, defaultFailure: MediaFailure) => {
      const session = sessionRef.current;
      if (
        !session ||
        session.signal.aborted ||
        sourceRef.current?.capabilityToken !== source.capabilityToken
      ) {
        return;
      }
      let failure = defaultFailure;
      try {
        await checkMediaSource(stableTarget, source.generation);
      } catch (error) {
        failure = asMediaFailure(error);
      }
      if (sessionRef.current !== session || session.signal.aborted) return;
      sessionRef.current = null;
      sourceRef.current = null;
      setState({ failure, phase: "failed" });
      void mediaSessionCoordinator.release(session);
    },
    [stableTarget],
  );

  const reportImageError = useCallback(
    (source: MediaSourceDescriptor) =>
      reportSourceFailure(source, { kind: "malformed" }),
    [reportSourceFailure],
  );

  const reportPlaybackError = useCallback(
    (source: MediaSourceDescriptor, failure: MediaFailure) =>
      reportSourceFailure(source, failure),
    [reportSourceFailure],
  );

  const openExternal = useCallback(async () => {
    setExternalOpenError(false);
    try {
      await sessionRef.current?.suspendForExternalOpen();
      await openMediaInSystem(stableTarget);
    } catch {
      setExternalOpenError(true);
    }
  }, [stableTarget]);

  const prepareFullPageHandoff = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    await session.suspendForExternalOpen();
    if (sessionRef.current !== session || session.signal.aborted) return;
    sessionRef.current = null;
    sourceRef.current = null;
    await mediaSessionCoordinator.handoff(session);
  }, []);

  const registerRendererDisposer = useCallback(
    (disposer: () => void | Promise<void>) => {
      const session = sessionRef.current;
      if (!session) {
        void disposer();
        return () => undefined;
      }
      return session.addDisposer(disposer);
    },
    [],
  );

  const registerExternalSuspender = useCallback(
    (suspender: () => void | Promise<void>) =>
      sessionRef.current?.addExternalSuspender(suspender) ?? (() => undefined),
    [],
  );

  return {
    externalOpenError,
    markReady,
    openExternal,
    prepareFullPageHandoff,
    registerExternalSuspender,
    registerRendererDisposer,
    reportImageError,
    reportPlaybackError,
    retry: () => setRetryKey((key) => key + 1),
    state,
    updateViewState,
    viewState,
  };
}

function asMediaFailure(error: unknown): MediaFailure {
  if (isMediaFailure(error)) return error;
  return {
    detail: error instanceof Error ? error.message : String(error),
    kind: "runtime_error",
  };
}

function isMediaFailure(value: unknown): value is MediaFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    typeof value.kind === "string"
  );
}
