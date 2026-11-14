import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  agentSessionForNavigationKey,
  agentSessionHasId,
  agentSessionNavigationIndex,
  agentSessionNavigationKey,
  pinnableAgentSessionItem,
  useActiveAgentSessions,
  useListedAgentSessions,
  type AgentSession,
} from "@/features/agent-sessions";
import {
  closeActiveContent,
  openScopeOwner,
  prepareActiveContentDeactivation,
} from "@/features/artifact";
import {
  pathNavigationKey,
  getNavigationState,
  hideNowRow,
  navigationKeyId,
  subscribeUserEdits,
  type NavigationItem,
  type NavigationKey,
} from "@/features/navigation";
import { getSpaceSnapshot, useSpace } from "@/features/space";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useMainAreaObject, type MainAreaObject } from "./main-area-object";
import {
  isSessionKey,
  nowOrderRow,
  type NowActiveRow,
  type NowRow,
} from "./now-model";
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
  keep(item);
}

function keep(item: NavigationItem) {
  getNavigationState()
    .keep(item)
    .catch((error: unknown) => {
      toast.error(m.navigation_keep_failed(), {
        description: getNativeErrorMessage(error),
      });
    });
}

/**
 * Keeps a session whose message the runtime accepted; false while it has
 * no identity to keep. A kept one stays as it is, by whichever key it is
 * kept, except that a row a Routine launch kept is kept again in its place
 * without the Routine, so the next launch does not take it (DF-210 R5).
 */
function keepMessagedSession(session: AgentSession | null): boolean {
  const item = pinnableAgentSessionItem(session);
  if (!session || !item) return false;
  const kept = getNavigationState().kept;
  const index = agentSessionNavigationIndex([...kept], session);
  if (index < 0) keepItem(item);
  else if (kept[index].routine)
    keep({ key: kept[index].key, title: item.title });
  return true;
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
 * artifact or expanded item on a user edit of the main area, a created
 * artifact once the
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
          if (
            current?.kind === "artifact" ||
            (current?.kind === "item" && current.shown)
          ) {
            keepItem(current.item);
          }
          return;
        }
        if (edit.kind === "message") {
          if (
            !keepMessagedSession(
              messagedSession(edit.sessionId, listedRef.current),
            )
          ) {
            messaged.current.add(edit.sessionId);
          }
          return;
        }
        const id = navigationKeyId(
          pathNavigationKey("page", edit.path, edit.spaceId, rootIdRef.current),
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
      if (!keepMessagedSession(messagedSession(sessionId, listedSessions))) {
        continue;
      }
      messaged.current.delete(sessionId);
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
 * Closing actions of the main area object and of Now. A closed object gives
 * way to the main page of its Space; on Home, to a new chat with its project.
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
   * on Home a new chat with its project (DF-259 R1).
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
    const spaceId = objectSpaceId(object);
    showSpaceMainPage(
      spaceId === undefined ? getSpaceSnapshot().activeSpaceId : spaceId,
      object?.kind === "item",
    );
    return true;
  }, [home, object, openContentSurface, showProjectChat]);

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
   * The close button of an active session's row: the row leaves Now and
   * stays hidden until a new event of the session, which keeps working; a
   * kept one is no longer kept, an open one closes its display after the
   * guards (DF-207 R1–R3).
   */
  const closeActiveSession = useCallback(
    async (row: NowActiveRow) => {
      if (
        isMainObject(agentSessionNavigationKey(row.session)) &&
        !(await closeDisplay())
      ) {
        return;
      }
      const state = getNavigationState();
      if (!state.projectPath) return;
      hideNowRow(state.projectPath, nowOrderRow(row));
      if (row.kept) await state.unkeep([row.kept.key]).catch(reportFailure);
    },
    [closeDisplay, isMainObject],
  );

  /**
   * "Close all" of Now: every row leaves it as its close button does, after
   * one guard of the main area when it shows one of them; pinned objects
   * stay (DF-207 R5).
   */
  const closeAll = useCallback(
    async (rows: readonly NowRow[]) => {
      const open = rows.some((row) => {
        switch (row.kind) {
          case "active":
            return row.main;
          case "kept":
            return isMainObject(row.item.key);
          case "temporary":
            return true;
        }
      });
      if (open && !(await closeDisplay())) return;
      const state = getNavigationState();
      if (!state.projectPath) return;
      for (const row of rows) {
        if (row.kind === "active")
          hideNowRow(state.projectPath, nowOrderRow(row));
      }
      await state
        .unkeep(state.kept.map((item) => item.key))
        .catch(reportFailure);
    },
    [closeDisplay, isMainObject],
  );

  return { closeMainAreaObject, closeItem, closeActiveSession, closeAll };
}

/**
 * The Space of a main area object, null for the project root: an artifact,
 * owner or item by its path, a session by its scope (DF-259 R2). Undefined
 * without an object or for a session whose Space the project does not list.
 */
function objectSpaceId(
  object: MainAreaObject | null,
): string | null | undefined {
  if (!object) return undefined;
  if (object.kind !== "session") {
    const key = object.item.key;
    return key.kind === "session" || key.kind === "sessionLaunch"
      ? undefined
      : (key.spaceId ?? null);
  }
  const { session } = object;
  if (session.scopeKind !== "space") return null;
  return getSpaceSnapshot().spaces.find(
    (space) =>
      space.id === session.spaceId ||
      (session.spacePath !== undefined && space.path === session.spacePath),
  )?.id;
}

/**
 * Shows the main page of a Space, or of the project root for null, in the
 * sidebar as well, as opening it from the sidebar does once the guards have
 * passed. The main page already shown stays (DF-259 R3); an item expanded
 * over it folds back into it.
 */
function showSpaceMainPage(spaceId: string | null, fromItem: boolean) {
  const { activeRootId, activeSpaceId, openSpace, clearActiveSpace } =
    getSpaceSnapshot();
  const target = spaceId ?? activeRootId;
  if (!target) {
    closeActiveContent();
    return;
  }
  if (target === activeRootId) {
    if (activeSpaceId) clearActiveSpace();
  } else if (target !== activeSpaceId) {
    void openSpace(target);
  }
  openScopeOwner(
    { kind: "space", spaceId: target },
    fromItem ? { scopeOpenIntent: { kind: "default" } } : undefined,
  );
}

function sameId(left: NavigationKey, right: NavigationKey) {
  return navigationKeyId(left) === navigationKeyId(right);
}
