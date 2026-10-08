import { useCallback, useEffect, useState } from "react";
import type { AgentSessionKeyDto } from "../api/chat";
import {
  loadLocalMedia,
  mediaBlob,
  readMediaData,
  releaseLocalMedia,
} from "../api/media";
import type { ChatMedia } from "../model/media";

/** What a media tile shows (`08` R2, display of a file). */
export type MediaView =
  | { state: "loading" }
  | {
      state: "ready";
      url: string;
      /** Known before the image decodes, to reserve its place. */
      width: number | null;
      height: number | null;
    }
  /** The file is no longer there. */
  | { state: "missing" }
  | { state: "too_large" }
  /** The runtime let the data go under its bound. */
  | { state: "released" }
  /** A read or format error. */
  | { state: "error" };

/**
 * Reads a media for display while its tile is mounted: the data the
 * runtime holds, else the local file as a stream. Nothing is written.
 * `fail` marks a media the window could not decode.
 */
export function useMediaView(
  session: AgentSessionKeyDto,
  media: ChatMedia,
): { view: MediaView; fail: () => void } {
  const [state, setState] = useState<{ key: string; view: MediaView } | null>(
    null,
  );
  const key = media.key;
  const path = media.path;
  const itemId = media.data?.itemId ?? null;
  const segmentId = media.data?.segmentId ?? null;

  useEffect(() => {
    let cancelled = false;
    let release: (() => void) | null = null;
    const settle = (view: MediaView) => {
      if (!cancelled) setState({ key, view });
    };
    const fromFile = async (): Promise<MediaView> => {
      if (!path) return { state: "error" };
      const outcome = await loadLocalMedia(path);
      if (!outcome.ok) {
        return outcome.failure === "missing"
          ? { state: "missing" }
          : { state: outcome.failure };
      }
      const { source } = outcome;
      if (cancelled) releaseLocalMedia(source.token);
      else release = () => releaseLocalMedia(source.token);
      return {
        state: "ready",
        url: source.url,
        width: source.width,
        height: source.height,
      };
    };
    const load = async (): Promise<MediaView> => {
      if (!itemId || !segmentId) return fromFile();
      const outcome = await readMediaData(session, itemId, segmentId);
      if (outcome.outcome === "available") {
        const url = URL.createObjectURL(
          mediaBlob(outcome.data, outcome.mimeType),
        );
        if (cancelled) URL.revokeObjectURL(url);
        else release = () => URL.revokeObjectURL(url);
        return { state: "ready", url, width: null, height: null };
      }
      if (
        outcome.outcome === "unavailable" &&
        outcome.reason !== "not_provided"
      ) {
        return { state: outcome.reason };
      }
      return path ? fromFile() : { state: "error" };
    };
    void load().then(settle, () => settle({ state: "error" }));
    return () => {
      cancelled = true;
      release?.();
    };
    // The session object identity is not part of the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, path, itemId, segmentId, session.agent, session.sessionId]);

  const fail = useCallback(
    () => setState({ key, view: { state: "error" } }),
    [key],
  );
  return {
    view: state?.key === key ? state.view : { state: "loading" },
    fail,
  };
}
