import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject,
} from "react";
import type { Terminal } from "@xterm/xterm";
import {
  parseSvodeDraggedResource,
  SVODE_RESOURCE_MIME,
} from "@/features/space/resource-drag";
import {
  prepareTerminalPaths,
  prepareTerminalResourcePaths,
} from "@/features/terminal/api/terminal";
import {
  EMPTY_NATIVE_DROP_TARGET_STATE,
  isPointInsideDropTarget,
  reduceNativeDropTarget,
  type NativeDropTargetState,
} from "@/features/terminal/lib/drop-target";
import { onNativeFileDrop } from "@/platform/native/file-drop";

export type TerminalDropOverlayState =
  | { kind: "active"; count: number }
  | { kind: "error" }
  | null;

interface UseTerminalDropOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  ptyId: string | null;
  enabled: boolean;
}

interface TerminalDropHandlers {
  onDragEnter: DragEventHandler<HTMLDivElement>;
  onDragOver: DragEventHandler<HTMLDivElement>;
  onDragLeave: DragEventHandler<HTMLDivElement>;
  onDrop: DragEventHandler<HTMLDivElement>;
}

export function useTerminalDrop({
  containerRef,
  terminalRef,
  ptyId,
  enabled,
}: UseTerminalDropOptions): {
  dropOverlay: TerminalDropOverlayState;
  dropHandlers: TerminalDropHandlers;
} {
  const [dropOverlay, setDropOverlay] =
    useState<TerminalDropOverlayState>(null);
  const errorTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const latestSessionRef = useRef({ ptyId, enabled });
  const nativeDropTargetRef = useRef<NativeDropTargetState>(
    EMPTY_NATIVE_DROP_TARGET_STATE,
  );

  const clearErrorTimer = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const showError = useCallback(() => {
    clearErrorTimer();
    setDropOverlay({ kind: "error" });
    errorTimerRef.current = window.setTimeout(() => {
      setDropOverlay(null);
      errorTimerRef.current = null;
    }, 2500);
  }, [clearErrorTimer]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearErrorTimer();
    };
  }, [clearErrorTimer]);

  useEffect(() => {
    latestSessionRef.current = { ptyId, enabled };
  }, [enabled, ptyId]);

  const requestIsCurrent = useCallback((requestedPtyId: string) => {
    const current = latestSessionRef.current;
    return (
      mountedRef.current && current.enabled && current.ptyId === requestedPtyId
    );
  }, []);

  const pastePreparedText = useCallback(
    (prepared: string) => {
      if (!enabled || /[\r\n]/.test(prepared)) {
        throw new Error("Terminal path preparation returned unsafe input");
      }
      const terminal = terminalRef.current;
      if (!terminal) throw new Error("Terminal is not ready");
      terminal.focus();
      terminal.scrollToBottom();
      terminal.paste(prepared);
    },
    [enabled, terminalRef],
  );

  const pasteNativePaths = useCallback(
    async (paths: string[]) => {
      if (!ptyId || paths.length === 0) return;
      const requestedPtyId = ptyId;
      try {
        const prepared = await prepareTerminalPaths(requestedPtyId, paths);
        if (!requestIsCurrent(requestedPtyId)) return;
        pastePreparedText(prepared);
      } catch (error) {
        if (!requestIsCurrent(requestedPtyId)) return;
        console.warn("Failed to prepare terminal file drop:", error);
        showError();
      }
    },
    [pastePreparedText, ptyId, requestIsCurrent, showError],
  );

  const pasteResource = useCallback(
    async (serialized: string) => {
      if (!ptyId) return;
      const requestedPtyId = ptyId;
      const resource = parseSvodeDraggedResource(serialized);
      if (!resource) {
        showError();
        return;
      }
      try {
        const prepared = await prepareTerminalResourcePaths(requestedPtyId, [
          resource,
        ]);
        if (!requestIsCurrent(requestedPtyId)) return;
        pastePreparedText(prepared);
      } catch (error) {
        if (!requestIsCurrent(requestedPtyId)) return;
        console.warn("Failed to prepare terminal resource drop:", error);
        showError();
      }
    },
    [pastePreparedText, ptyId, requestIsCurrent, showError],
  );

  useEffect(() => {
    if (!enabled || !ptyId) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void onNativeFileDrop((event) => {
      if (cancelled) return;
      if (event.type === "leave") {
        nativeDropTargetRef.current = reduceNativeDropTarget(
          nativeDropTargetRef.current,
          event,
          false,
        );
        setDropOverlay(null);
        return;
      }

      const container = containerRef.current;
      const inside =
        container !== null &&
        isPointInsideDropTarget(
          event.position,
          container.getBoundingClientRect(),
        );
      const targetEvent =
        event.type === "enter"
          ? { type: event.type, pathCount: event.paths.length }
          : { type: event.type };
      const targetState = reduceNativeDropTarget(
        nativeDropTargetRef.current,
        targetEvent,
        inside,
      );
      nativeDropTargetRef.current = targetState;
      setDropOverlay(
        targetState.overlayCount === null
          ? null
          : { kind: "active", count: targetState.overlayCount },
      );

      if (event.type === "drop") {
        setDropOverlay(null);
        if (inside) void pasteNativePaths(event.paths);
      }
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.warn("Failed to listen for native terminal file drops:", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      nativeDropTargetRef.current = EMPTY_NATIVE_DROP_TARGET_STATE;
      setDropOverlay(null);
    };
  }, [containerRef, enabled, pasteNativePaths, ptyId]);

  const onDragEnter: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!enabled || !event.dataTransfer.types.includes(SVODE_RESOURCE_MIME)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDropOverlay({ kind: "active", count: 1 });
    },
    [enabled],
  );

  const onDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!enabled || !event.dataTransfer.types.includes(SVODE_RESOURCE_MIME)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeave: DragEventHandler<HTMLDivElement> = useCallback((event) => {
    if (
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    ) {
      return;
    }
    setDropOverlay(null);
  }, []);

  const onDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!enabled || !event.dataTransfer.types.includes(SVODE_RESOURCE_MIME)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setDropOverlay(null);
      void pasteResource(event.dataTransfer.getData(SVODE_RESOURCE_MIME));
    },
    [enabled, pasteResource],
  );

  return {
    dropOverlay: enabled ? dropOverlay : null,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
