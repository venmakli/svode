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
      const targetId = event.spaceId;
      if (!targetId) return;

      useSpaceStore.setState((state) => ({
        spaces: state.spaces.map((space) =>
          space.id === targetId ? { ...space, lfsState: event.state } : space,
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
