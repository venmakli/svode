import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  agentSessionForNavigationKey,
  useActiveAgentSessions,
} from "@/features/agent-sessions";
import {
  closeActiveContent,
  prepareActiveContentDeactivation,
} from "@/features/artifact";
import {
  artifactNavigationKey,
  getNavigationState,
  navigationKeyId,
  subscribeUserEdits,
  type NavigationItem,
  type NavigationKey,
} from "@/features/navigation";
import { useSpace } from "@/features/space";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useMainAreaObject, type MainAreaObject } from "./main-area-object";
import { isSessionKey } from "./now-model";
import { useShellStore } from "./model";
import * as m from "@/paraglide/messages.js";

/** A created artifact is kept if the main area shows it within this time. */
const CREATED_OPEN_TIMEOUT_MS = 10_000;

function isListed(key: NavigationKey): boolean {
  const id = navigationKeyId(key);
  const state = getNavigationState();
  return (
    state.pendingKeyIds.has(id) ||
    [...state.pinned, ...state.kept].some(
      (item) => navigationKeyId(item.key) === id,
    )
  );
}

function reportFailure(error: unknown) {
  toast.error(m.navigation_close_failed(), {
    description: getNativeErrorMessage(error),
  });
}

function keepItem(item: NavigationItem) {
  if (isListed(item.key)) return;
  getNavigationState()
    .keep(item)
    .catch((error: unknown) => {
      toast.error(m.navigation_keep_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
}

/**
 * Keeps the objects that the edit signal reports: the temporary main area
 * artifact on a user edit of the main area, and a created artifact once the
 * main area shows it. Mount once in app composition.
 */
export function useKeepEditedObjects() {
  const object = useMainAreaObject();
  const rootId = useSpace((state) => state.activeRootId);
  const objectRef = useRef<MainAreaObject | null>(object);
  const rootIdRef = useRef(rootId);
  const created = useRef<{ id: string; until: number } | null>(null);
  const objectId = object ? navigationKeyId(object.item.key) : null;

  useEffect(() => {
    objectRef.current = object;
    rootIdRef.current = rootId;
  });

  useEffect(
    () =>
      subscribeUserEdits((edit) => {
        const current = objectRef.current;
        if (edit.kind === "edit") {
          if (current?.kind === "artifact") keepItem(current.item);
          return;
        }
        const id = navigationKeyId(
          artifactNavigationKey(
            "page",
            edit.path,
            edit.spaceId,
            rootIdRef.current,
          ),
        );
        if (current && navigationKeyId(current.item.key) === id) {
          keepItem(current.item);
          created.current = null;
        } else {
          created.current = { id, until: Date.now() + CREATED_OPEN_TIMEOUT_MS };
        }
      }),
    [],
  );

  // The next object of the main area settles a created artifact.
  useEffect(() => {
    const pending = created.current;
    const current = objectRef.current;
    if (!pending || !current || !objectId) return;
    created.current = null;
    if (pending.id === objectId && Date.now() <= pending.until) {
      keepItem(current.item);
    }
  }, [objectId]);
}

/** Closing actions of the main area object and of Now. */
export function useWorkingSetActions() {
  const object = useMainAreaObject();
  const activeSessions = useActiveAgentSessions();
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const closeGraphSurface = useShellStore((state) => state.closeGraphSurface);

  const isActiveSession = useCallback(
    (key: NavigationKey) =>
      (key.kind === "session" || key.kind === "sessionLaunch") &&
      agentSessionForNavigationKey(key, activeSessions) !== null,
    [activeSessions],
  );

  /** Whether a key addresses the main area object; a session by id or launch. */
  const isMainObject = useCallback(
    (key: NavigationKey) => {
      if (!object) return false;
      if (object.kind === "session") {
        return (
          isSessionKey(key) &&
          agentSessionForNavigationKey(key, [object.session]) !== null
        );
      }
      return sameId(object.item.key, key);
    },
    [object],
  );

  /** Closes the display after the guards; the main page of its Space shows. */
  const closeDisplay = useCallback(async () => {
    if ((await prepareActiveContentDeactivation()) === "blocked") return false;
    if (useShellStore.getState().mainSurface === "session") {
      openContentSurface();
    }
    closeActiveContent();
    return true;
  }, [openContentSurface]);

  /**
   * ⌘W without a peek: the Graph returns to its object; the main area object
   * closes and leaves Now unless it is pinned or an active session.
   */
  const closeMainAreaObject = useCallback(async () => {
    if (useShellStore.getState().mainSurface === "graph") {
      closeGraphSurface();
      return;
    }
    if (!object) {
      // A session the catalog no longer lists still closes.
      if (useShellStore.getState().mainSurface === "session") {
        await closeDisplay();
      }
      return;
    }
    if (!(await closeDisplay())) return;
    const kept =
      getNavigationState().kept.find((item) => isMainObject(item.key))?.key ??
      null;
    if (kept && !isActiveSession(kept)) {
      await getNavigationState().unkeep([kept]).catch(reportFailure);
    }
  }, [closeDisplay, closeGraphSurface, isActiveSession, isMainObject, object]);

  /** The close button of a Now item; an open item also closes its display. */
  const closeItem = useCallback(
    async (key: NavigationKey) => {
      if (isMainObject(key) && !(await closeDisplay())) return;
      if (getNavigationState().kept.some((item) => sameId(item.key, key))) {
        await getNavigationState().unkeep([key]).catch(reportFailure);
      }
    },
    [closeDisplay, isMainObject],
  );

  /**
   * "Close all": the working set leaves Now and its open object closes;
   * active sessions stay in Now as active.
   */
  const closeAll = useCallback(
    async (temporary: boolean) => {
      const openKept =
        object !== null &&
        !isActiveSession(object.item.key) &&
        getNavigationState().kept.some((item) => isMainObject(item.key));
      if ((temporary || openKept) && !(await closeDisplay())) return;
      const state = getNavigationState();
      await state
        .unkeep(state.kept.map((item) => item.key))
        .catch(reportFailure);
    },
    [closeDisplay, isActiveSession, isMainObject, object],
  );

  return { closeMainAreaObject, closeItem, closeAll };
}

function sameId(left: NavigationKey, right: NavigationKey) {
  return navigationKeyId(left) === navigationKeyId(right);
}
