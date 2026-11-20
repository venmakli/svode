import { useEffect } from "react";
import { listenSpaceLfsStateChanged } from "../api/space-actions";
import { useSpaceStore } from "../model";

export function useSpaceLfsStateSync(projectPath: string | null): void {
  useEffect(() => {
    if (!projectPath) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listenSpaceLfsStateChanged((event) => {
      if (cancelled) return;
      if (event.projectPath !== projectPath) return;
      const status = { state: event.state, missing: event.missing };
      const targetId = event.spaceId;
      // No Space id: the project's own repository, the root Space.
      if (!targetId) {
        useSpaceStore.setState({ activeRootLfs: status });
        return;
      }

      useSpaceStore.setState((state) => ({
        spaces: state.spaces.map((space) =>
          space.id === targetId
            ? { ...space, lfsState: status.state, lfsMissing: status.missing }
            : space,
        ),
      }));
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [projectPath]);
}
