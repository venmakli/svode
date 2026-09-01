import { useCallback, useEffect, useRef, useState } from "react";

import {
  listenAttachmentOwnerLifecycle,
  listenAttachmentsInvalidated,
  type AttachmentOwnerLifecycleEventDto,
} from "@/platform/attachments/attachments-api";
import type { ScopeOwnerRef } from "@/features/scope-surfaces";

import { getAttachmentsSnapshot } from "../api/attachments-api";
import {
  attachmentOwnerGenerationKey,
  attachmentOwnerInput,
  sameRuntimePath,
  type AttachmentsSnapshot,
  type AttachmentsSourceState,
} from "../model/types";

const INVALIDATION_COALESCE_MS = 80;

export function useAttachmentsSource(
  owner: ScopeOwnerRef,
  onSnapshot?: (snapshot: AttachmentsSnapshot) => void,
) {
  const ownerKey = attachmentOwnerGenerationKey(owner);
  const ownerInput = attachmentOwnerInput(owner);
  const projectPath = ownerInput.projectPath;
  const spaceId = ownerInput.spaceId;
  const [state, setState] = useState<AttachmentsSourceState>({
    phase: "initial",
  });
  const activeOwnerKeyRef = useRef(ownerKey);
  const requestGenerationRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const requestGeneration = ++requestGenerationRef.current;
    try {
      const snapshot = await getAttachmentsSnapshot({ projectPath, spaceId });
      if (
        !isCurrentAttachmentsLoad(
          activeOwnerKeyRef.current,
          ownerKey,
          requestGeneration,
          requestGenerationRef.current,
        )
      ) {
        return;
      }
      onSnapshot?.(snapshot);
      setState({ phase: "ready", refreshError: null, snapshot });
    } catch (error) {
      if (
        !isCurrentAttachmentsLoad(
          activeOwnerKeyRef.current,
          ownerKey,
          requestGeneration,
          requestGenerationRef.current,
        )
      ) {
        return;
      }
      const message = attachmentErrorMessage(error);
      setState((current) =>
        current.phase === "ready"
          ? { ...current, refreshError: message }
          : { message, phase: "blocking_error" },
      );
    }
  }, [onSnapshot, ownerKey, projectPath, spaceId]);

  useEffect(() => {
    activeOwnerKeyRef.current = ownerKey;
    requestGenerationRef.current += 1;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setState({ phase: "initial" });
        void refresh();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ownerKey, refresh]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const scheduleRefresh = () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, INVALIDATION_COALESCE_MS);
    };
    void Promise.all([
      listenAttachmentsInvalidated((event) => {
        if (
          event.ownerPath === "." &&
          sameRuntimePath(event.spacePath, owner.spacePath)
        ) {
          scheduleRefresh();
        }
      }),
      listenAttachmentOwnerLifecycle((event) => {
        if (lifecycleAffectsOwner(event, owner)) scheduleRefresh();
      }),
    ]).then((dispose) => {
      if (cancelled) {
        dispose.forEach((callback) => callback());
      } else {
        unlisten.push(...dispose);
      }
    });
    const onFocus = () => scheduleRefresh();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") scheduleRefresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      unlisten.forEach((callback) => callback());
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    };
  }, [owner, refresh]);

  return { refresh, state };
}

export function isCurrentAttachmentsLoad(
  activeOwnerKey: string,
  requestOwnerKey: string,
  requestGeneration: number,
  currentRequestGeneration: number,
) {
  return (
    activeOwnerKey === requestOwnerKey &&
    requestGeneration === currentRequestGeneration
  );
}

function lifecycleAffectsOwner(
  event: AttachmentOwnerLifecycleEventDto,
  owner: ScopeOwnerRef,
) {
  if (!sameRuntimePath(event.projectPath, owner.projectPath)) return false;
  const ownerIsRoot = owner.projectPath === owner.spacePath;
  if (event.kind === "synced") {
    return ownerIsRoot
      ? event.spaceId == null
      : event.spaceId === owner.spaceId;
  }
  return ownerIsRoot || event.spaceId === owner.spaceId;
}

function attachmentErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Attachments source unavailable";
}
