import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  useResourceDropTarget,
  type DroppedResources,
  type ResourceDropHandlers,
  type ResourceDropOverlayState,
} from "@/features/space/resource-drag";
import {
  prepareTerminalPaths,
  prepareTerminalResourcePaths,
} from "@/features/terminal/api/terminal";

interface UseTerminalDropOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  ptyId: string | null;
  enabled: boolean;
}

/**
 * Files of the OS and sidebar resources dropped on a terminal become shell
 * tokens in its input line, quoted by the backend for the session's shell.
 */
export function useTerminalDrop({
  containerRef,
  terminalRef,
  ptyId,
  enabled,
}: UseTerminalDropOptions): {
  dropOverlay: ResourceDropOverlayState;
  dropHandlers: ResourceDropHandlers;
} {
  const latestSessionRef = useRef({ ptyId, enabled });
  useEffect(() => {
    latestSessionRef.current = { ptyId, enabled };
  }, [enabled, ptyId]);

  const requestIsCurrent = useCallback((requestedPtyId: string) => {
    const current = latestSessionRef.current;
    return current.enabled && current.ptyId === requestedPtyId;
  }, []);

  const pastePreparedText = useCallback(
    (prepared: string) => {
      if (/[\r\n]/.test(prepared)) {
        throw new Error("Terminal path preparation returned unsafe input");
      }
      const terminal = terminalRef.current;
      if (!terminal) throw new Error("Terminal is not ready");
      terminal.focus();
      terminal.scrollToBottom();
      terminal.paste(prepared);
    },
    [terminalRef],
  );

  const onDrop = useCallback(
    async (dropped: DroppedResources) => {
      if (!ptyId) return;
      const requestedPtyId = ptyId;
      try {
        const prepared =
          dropped.kind === "paths"
            ? await prepareTerminalPaths(requestedPtyId, dropped.paths)
            : await prepareTerminalResourcePaths(requestedPtyId, [
                dropped.resource,
              ]);
        if (!requestIsCurrent(requestedPtyId)) return;
        pastePreparedText(prepared);
      } catch (error) {
        // A drop meant for a session that is gone shows nothing.
        if (requestIsCurrent(requestedPtyId)) throw error;
      }
    },
    [pastePreparedText, ptyId, requestIsCurrent],
  );

  const { overlay, handlers } = useResourceDropTarget({
    containerRef,
    enabled: enabled && ptyId !== null,
    onDrop,
  });
  return { dropOverlay: overlay, dropHandlers: handlers };
}
