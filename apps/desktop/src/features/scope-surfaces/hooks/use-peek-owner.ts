import { useCallback, useEffect, useState } from "react";
import {
  listenFileCreated,
  listenFileChanged,
  listenFileDeleted,
} from "@/platform/filesystem/file-events-api";
import { resolvePeekOwner } from "../api/peek-owner";
import type { ScopePeekContext } from "../model/peek";
import type { ScopeOwnerRef } from "../model/types";

export function usePeekOwner(
  input: Pick<
    ScopePeekContext,
    "path" | "directory" | "spaceId" | "spacePath" | "projectPath"
  >,
) {
  const { path, directory, spaceId, spacePath, projectPath } = input;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    owner: ScopeOwnerRef | null;
    error: string | null;
  }>({ owner: null, error: null });
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let disposed = false;
    void resolvePeekOwner({ path, directory, spaceId, spacePath, projectPath })
      .then((owner) => {
        if (!disposed) setState({ owner, error: null });
      })
      .catch((error: unknown) => {
        if (!disposed)
          setState((current) => ({ ...current, error: String(error) }));
      });
    return () => {
      disposed = true;
    };
  }, [path, directory, spaceId, spacePath, projectPath, revision]);
  useEffect(() => {
    const refresh = (event: { space?: string; path: string }) => {
      if (event.space && event.space !== spacePath) return;
      const ownerPath = directory ? path : path.slice(0, path.lastIndexOf("/"));
      if (event.path === path || event.path.startsWith(`${ownerPath}/`))
        retry();
    };
    const listeners = [
      listenFileCreated(refresh),
      listenFileChanged(refresh),
      listenFileDeleted(refresh),
    ];
    return () => {
      for (const listener of listeners)
        void listener.then((unlisten) => unlisten());
    };
  }, [directory, path, retry, spacePath]);
  return { ...state, retry };
}
