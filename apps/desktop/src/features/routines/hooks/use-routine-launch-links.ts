import { useEffect, useMemo, useState } from "react";

import {
  listenRoutineCatalogInvalidated,
  loadRoutineLaunchLinks,
} from "../api/routines-api";
import type { RoutineLaunchLink } from "../model/types";

const NO_LINKS: ReadonlyMap<string, RoutineLaunchLink> = new Map();

/**
 * The Routines that launched sessions, keyed by launch id. Resolved by the
 * Routines owner whenever the launch set or `revision` changes and whenever a
 * Routine of the project is invalidated; links stay while a reload runs.
 */
export function useRoutineLaunchLinks(
  projectPath: string | null,
  launchIds: readonly string[],
  revision?: string | null,
): ReadonlyMap<string, RoutineLaunchLink> {
  const launchKey = useMemo(
    () => [...new Set(launchIds)].sort().join("\n"),
    [launchIds],
  );
  const [state, setState] = useState<{
    projectPath: string | null;
    links: ReadonlyMap<string, RoutineLaunchLink>;
  }>({ projectPath: null, links: NO_LINKS });

  useEffect(() => {
    if (!projectPath || !launchKey) return;
    const ids = launchKey.split("\n");
    let disposed = false;
    let generation = 0;
    const load = () => {
      const current = ++generation;
      loadRoutineLaunchLinks(projectPath, ids).then(
        (links) => {
          if (disposed || current !== generation) return;
          setState({
            projectPath,
            links: new Map(links.map((link) => [link.launchId, link])),
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
  }, [launchKey, projectPath, revision]);

  return state.projectPath === projectPath && launchKey ? state.links : NO_LINKS;
}
