import { useEffect, useState } from "react";
import {
  listenSpaceLfsStateChanged,
  requestSpaceLfsUnsent,
} from "../api/space-actions";
import { useSpaceStore } from "../model";

export function useSpaceLfsStateSync(projectPath: string | null): void {
  const [listening, setListening] = useState<string | null>(null);
  // The Spaces shown for the project; a new one asks for its send queue.
  const spaceIds = useSpaceStore((state) =>
    state.spaces.map((space) => space.id).join("\n"),
  );

  useEffect(() => {
    if (!projectPath) return;

    let unlisten: (() => void) | null = null;
    let cancelled = false;

    listenSpaceLfsStateChanged((event) => {
      if (cancelled) return;
      if (event.projectPath !== projectPath) return;
      const status = {
        state: event.state,
        missing: event.missing,
        unsent: event.unsent ?? null,
      };
      const targetId = event.spaceId;
      // No Space id: the project's own repository, the root Space.
      if (!targetId) {
        useSpaceStore.setState({ activeRootLfs: status });
        return;
      }

      useSpaceStore.setState((state) => ({
        spaces: state.spaces.map((space) =>
          space.id === targetId
            ? {
                ...space,
                lfsState: status.state,
                lfsMissing: status.missing,
                lfsUnsent: status.unsent,
              }
            : space,
        ),
      }));
    }).then((dispose) => {
      if (cancelled) dispose();
      else {
        unlisten = dispose;
        setListening(projectPath);
      }
    });

    return () => {
      cancelled = true;
      setListening(null);
      if (unlisten) unlisten();
    };
  }, [projectPath]);

  // The files a previous run left unsent show once the window listens.
  useEffect(() => {
    if (!projectPath || listening !== projectPath) return;
    requestSpaceLfsUnsent(projectPath).catch((error) =>
      console.warn("refresh_lfs_unsent failed:", error),
    );
  }, [listening, projectPath, spaceIds]);
}
