import { useCallback, useEffect, useMemo, useState } from "react";

import {
  listenRoutineCatalogInvalidated,
  loadRoutineLaunchLinks,
} from "../api/routines-api";
import type { RoutineLaunchLink, RoutineLaunchSession } from "../model/types";

interface ResolvedLinks {
  byLaunch: ReadonlyMap<string, RoutineLaunchLink>;
  bySession: ReadonlyMap<string, RoutineLaunchLink>;
}

const NO_LINKS: ResolvedLinks = { byLaunch: new Map(), bySession: new Map() };

/**
 * The Routines that launched sessions: a session resolves by the launch id
 * it carries, else by its catalog id, which identifies an ACP launch.
 * Resolved by the Routines owner whenever the session set or `revision`
 * changes and whenever a Routine of the project is invalidated; links stay
 * while a reload runs.
 */
export function useRoutineLaunchLinks(
  projectPath: string | null,
  sessions: readonly RoutineLaunchSession[],
  revision?: string | null,
): (session: RoutineLaunchSession) => RoutineLaunchLink | null {
  const lookupKey = useMemo(() => {
    const launchIds = new Set<string>();
    const sessionIds = new Set<string>();
    for (const session of sessions) {
      if (session.launchId) launchIds.add(session.launchId);
      else sessionIds.add(session.id);
    }
    return JSON.stringify([[...launchIds].sort(), [...sessionIds].sort()]);
  }, [sessions]);
  const [state, setState] = useState<{
    projectPath: string | null;
    links: ResolvedLinks;
  }>({ projectPath: null, links: NO_LINKS });

  useEffect(() => {
    const [launchIds, sessionIds] = JSON.parse(lookupKey) as [
      string[],
      string[],
    ];
    if (!projectPath || (!launchIds.length && !sessionIds.length)) return;
    let disposed = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      loadRoutineLaunchLinks(projectPath, launchIds, sessionIds).then(
        (links) => {
          if (disposed || current !== generation) return;
          setState({
            projectPath,
            links: {
              byLaunch: new Map(links.map((link) => [link.launchId, link])),
              bySession: new Map(
                links.map((link) => [link.agentSessionId, link]),
              ),
            },
          });
        },
        (error: unknown) => {
          console.warn("failed to resolve routine launches", error);
        },
      );
    };
    load();
    let unlisten: (() => void) | null = null;
    void listenRoutineCatalogInvalidated((event) => {
      if (event.projectPath === projectPath) load();
    }).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      () => undefined,
    );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [lookupKey, projectPath, revision]);

  const links = state.projectPath === projectPath ? state.links : NO_LINKS;
  return useCallback(
    (session) =>
      (session.launchId
        ? links.byLaunch.get(session.launchId)
        : links.bySession.get(session.id)) ?? null,
    [links],
  );
}
