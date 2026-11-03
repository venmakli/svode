import { useEffect } from "react";
import {
  followContentRelocation,
  followReportedContentRelocation,
} from "@/features/page/navigation";
import { listenAgentContentRelocation } from "../api/space-watch-actions";
import {
  createFileTreeEditorSync,
  type FileTreeEditorSync,
} from "../effects/file-tree-editor-sync";
import { relocatedItemPath } from "../lib/content-relocation";
import { useSpaceStore, type SpaceState } from "../model";

// A move whose end never arrives (the app lost the request) stops holding
// the paths it would leave.
const UNFINISHED_MOVE_MS = 30_000;

interface RunningMove {
  sync: FileTreeEditorSync;
  finish: () => void;
  timer: ReturnType<typeof setTimeout>;
}

function watchedSpaceId(state: SpaceState, spacePath: string): string | null {
  if (state.activeRootPath === spacePath) return state.activeRootId;
  return (
    state.spaces.find(
      (space) => space.status === "ready" && space.path === spacePath,
    )?.id ?? null
  );
}

/**
 * A move an agent runs through Svode MCP takes the open content to its new
 * path, as a move in this window does: the paths it leaves are not taken for
 * gone while it runs, and the open Page, a converted parent Page or a Page
 * inside a moved folder goes on at its new path after it.
 */
export function useAgentContentRelocation() {
  useEffect(() => {
    const running = new Map<string, RunningMove[]>();
    const end = (space: string, move: RunningMove) => {
      const moves = running.get(space) ?? [];
      if (!moves.includes(move)) return;
      running.set(
        space,
        moves.filter((item) => item !== move),
      );
      clearTimeout(move.timer);
      move.finish();
    };

    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenAgentContentRelocation((event) => {
      const state = useSpaceStore.getState();
      const spaceId = watchedSpaceId(state, event.space);
      if (!spaceId) return;

      if (event.phase === "started") {
        const move: RunningMove = {
          sync: createFileTreeEditorSync(spaceId, event.space),
          finish: state.beginTreePathMutation(event.space),
          timer: setTimeout(() => end(event.space, move), UNFINISHED_MOVE_MS),
        };
        running.set(event.space, [...(running.get(event.space) ?? []), move]);
        return;
      }

      const move = running.get(event.space)?.[0];
      const sync = move?.sync ?? createFileTreeEditorSync(spaceId, event.space);
      for (const relocation of event.relocations) {
        sync.suppressPaths([relocation.from, relocation.to]);
        if (!relocation.converted)
          followContentRelocation(
            event.space,
            spaceId,
            relocation.from,
            relocation.to,
          );
      }
      const relocate = (path: string) => {
        for (const relocation of event.relocations) {
          const to = relocatedItemPath(path, relocation);
          if (to) return to;
        }
        return null;
      };
      // A shown Page keeps its session; a selection without one is reopened.
      followReportedContentRelocation(event.space, relocate);
      sync.followInitialPage(relocate);
      if (move) end(event.space, move);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
      for (const [space, moves] of running)
        for (const move of moves) end(space, move);
    };
  }, []);
}
