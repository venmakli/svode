import { useCallback, useEffect, useRef, useState } from "react";

import {
  getAttachmentsSnapshot,
  subscribeAttachmentOwnerLifecycle,
  subscribeAttachmentsInvalidated,
  type AttachmentOwnerLifecycleEventDto,
} from "../api/attachments-api";
import {
  attachmentOwnerGenerationKey,
  attachmentOwnerInput,
  sameRuntimePath,
  type AttachmentOwnerRef,
  type AttachmentRow,
  type AttachmentsSnapshot,
} from "../model/types";

import {
  AttachmentSourceSession,
  type AttachmentSourceView,
} from "../model/source-session";

const INVALIDATION_COALESCE_MS = 80;

export function useAttachmentsSource(
  owner: AttachmentOwnerRef,
  onSnapshot?: (snapshot: AttachmentsSnapshot) => void,
) {
  const ownerKey = attachmentOwnerGenerationKey(owner);
  const ownerInput = attachmentOwnerInput(owner);
  const projectPath = ownerInput.projectPath;
  const ownerPath = ownerInput.ownerPath;
  const spaceId = ownerInput.spaceId;
  const spacePath = owner.spacePath;
  const [view, setView] = useState<AttachmentSourceView>({
    state: { phase: "initial" },
    branches: new Map(),
    expanded: new Set(),
  });
  const sessionRef = useRef<AttachmentSourceSession | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(async () => {
    await sessionRef.current?.refresh();
  }, []);
  const loadBranch = useCallback(async (path: string) => {
    await sessionRef.current?.loadBranch(path);
  }, []);
  const toggle = useCallback((path: string) => {
    sessionRef.current?.toggle(path);
  }, []);
  const observeBranch = useCallback(
    (path: string) => sessionRef.current?.observe(path),
    [],
  );
  const retainPeekTarget = useCallback(
    (row: AttachmentRow) => sessionRef.current?.retainPeekTarget(row),
    [],
  );
  const inventory = useCallback(
    () => sessionRef.current?.inventory() ?? null,
    [],
  );

  useEffect(() => {
    const session = new AttachmentSourceSession(
      { ownerPath, projectPath, spaceId },
      getAttachmentsSnapshot,
      (next, snapshot) => {
        setView(next);
        if (snapshot) onSnapshot?.(snapshot);
      },
    );
    sessionRef.current = session;
    queueMicrotask(() => {
      if (sessionRef.current === session) {
        setView(session.current);
        void session.refreshRoot();
      }
    });
    return () => {
      session.dispose();
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [ownerKey, ownerPath, projectPath, spaceId, onSnapshot]);

  useEffect(() => {
    let cancelled = false;
    const unlisten: Array<() => void> = [];
    const scheduleRefresh = () => {
      sessionRef.current?.invalidate();
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        void refresh();
      }, INVALIDATION_COALESCE_MS);
    };
    void Promise.all([
      subscribeAttachmentsInvalidated((event) => {
        if (
          (ownerPath === "." ||
            event.ownerPath === ownerPath ||
            event.ownerPath.startsWith(`${ownerPath}/`) ||
            ownerPath.startsWith(`${event.ownerPath}/`) ||
            event.ownerPath === ".") &&
          sameRuntimePath(event.spacePath, spacePath)
        ) {
          scheduleRefresh();
        }
      }),
      subscribeAttachmentOwnerLifecycle((event) => {
        if (lifecycleAffectsOwner(event, { projectPath, spaceId, spacePath })) {
          scheduleRefresh();
        }
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
  }, [ownerPath, projectPath, refresh, spaceId, spacePath]);

  return {
    refresh,
    loadBranch,
    toggle,
    inventory,
    observeBranch,
    retainPeekTarget,
    ...view,
  };
}

function lifecycleAffectsOwner(
  event: AttachmentOwnerLifecycleEventDto,
  owner: {
    projectPath: string;
    spaceId: string | null;
    spacePath: string;
  },
) {
  if (!sameRuntimePath(event.projectPath, owner.projectPath)) return false;
  const ownerIsRoot = owner.spaceId === null;
  if (event.kind === "synced") {
    return ownerIsRoot
      ? event.spaceId == null
      : event.spaceId === owner.spaceId;
  }
  return ownerIsRoot || event.spaceId === owner.spaceId;
}
