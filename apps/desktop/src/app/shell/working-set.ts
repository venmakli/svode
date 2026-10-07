import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  agentSessionForNavigationKey,
  agentSessionHasId,
  pinnableAgentSessionItem,
  useActiveAgentSessions,
  useListedAgentSessions,
  type AgentSession,
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
import { useShowProjectChat } from "./show-project-chat";
import { useShellStore } from "./model";
import { useShellView } from "./shell-view";
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

/** The catalogue session of an accepted message, once listed. */
function messagedSession(
  sessionId: string,
  sessions: readonly AgentSession[] | null,
): AgentSession | null {
  return (
    sessions?.find((session) => agentSessionHasId(session, sessionId)) ?? null
  );
}

/**
 * Keeps the objects that the edit signal reports: the temporary main area
 * artifact on a user edit of the main area, a created artifact once the
 * main area shows it, and a session whose chat message the runtime
 * accepted once the catalogue lists it. Mount once in app composition.
 */
export function useKeepEditedObjects() {
  const object = useMainAreaObject();
  const rootId = useSpace((state) => state.activeRootId);
  const listedSessions = useListedAgentSessions();
  const objectRef = useRef<MainAreaObject | null>(object);
  const rootIdRef = useRef(rootId);
  const listedRef = useRef(listedSessions);
  const created = useRef<{ id: string; until: number } | null>(null);
  /** Messaged sessions the catalogue does not list yet, e.g. a new one. */
  const messaged = useRef(new Set<string>());
  const objectId = object ? navigationKeyId(object.item.key) : null;

  useEffect(() => {
    objectRef.current = object;
    rootIdRef.current = rootId;
    listedRef.current = listedSessions;
  });

  useEffect(
    () =>
      subscribeUserEdits((edit) => {
        const current = objectRef.current;
        if (edit.kind === "edit") {
          if (current?.kind === "artifact") keepItem(current.item);
          return;
        }
        if (edit.kind === "message") {
          const item = pinnableAgentSessionItem(
            messagedSession(edit.sessionId, listedRef.current),
          );
          if (item) keepItem(item);
          else messaged.current.add(edit.sessionId);
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

  // A messaged session follows its canonical record into Now.
  useEffect(() => {
    for (const sessionId of messaged.current) {
      const item = pinnableAgentSessionItem(
        messagedSession(sessionId, listedSessions),
      );
      if (!item) continue;
      messaged.current.delete(sessionId);
      keepItem(item);
    }
  }, [listedSessions]);

  // A project switch drops the sessions of the previous one.
  useEffect(() => {
    messaged.current.clear();
  }, [rootId]);

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

/**
 * Closing actions of the main area object and of Now. On Home a closed
 * object gives way to a new chat with its project, not to a Space page.
 */
export function useWorkingSetActions() {
  const object = useMainAreaObject();
  const activeSessions = useActiveAgentSessions();
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  const closeGraphSurface = useShellStore((state) => state.closeGraphSurface);
  const home = useShellView() === "home";
  const showProjectChat = useShowProjectChat();

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

  /**
   * Closes the display after the guards; the main page of its Space shows,
   * on Home a new chat with its project.
   */
  const closeDisplay = useCallback(async () => {
    if ((await prepareActiveContentDeactivation()) === "blocked") return false;
    if (home) {
      closeActiveContent();
      showProjectChat();
      return true;
    }
    if (useShellStore.getState().mainSurface === "session") {
      openContentSurface();
    }
    closeActiveContent();
    return true;
  }, [home, openContentSurface, showProjectChat]);

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
      // A session the catalog no longer lists still closes; the new chat of
      // Home is already what closing would show.
      const { mainSurface, mainSessionDraft } = useShellStore.getState();
      if (mainSurface === "session" && !(home && mainSessionDraft)) {
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
  }, [
    closeDisplay,
    closeGraphSurface,
    home,
    isActiveSession,
    isMainObject,
    object,
  ]);

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
