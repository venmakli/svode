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
import {
  onNativeFileDrop,
  readNativeFileDragPaths,
  resolveDroppedFilePaths,
} from "@/platform/native/file-drop";

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
  const nativeFilePathsRef = useRef<Promise<string[]> | null>(null);
  const nativeFileDragTokenRef = useRef(0);

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

  const clearActiveDrag = useCallback(() => {
    nativeFileDragTokenRef.current += 1;
    nativeFilePathsRef.current = null;
    nativeDropTargetRef.current = EMPTY_NATIVE_DROP_TARGET_STATE;
    if (!mountedRef.current) return;
    setDropOverlay((current) =>
      current?.kind === "active" ? null : current,
    );
  }, []);

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

  const readCachedNativeFilePaths = useCallback(() => {
    if (!nativeFilePathsRef.current) {
      nativeFilePathsRef.current = readNativeFileDragPaths().catch((error) => {
        console.warn("Failed to read native file drag paths:", error);
        return [];
      });
    }
    return nativeFilePathsRef.current;
  }, []);

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
      if (event.type === "enter") clearErrorTimer();
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
      clearActiveDrag();
    };
  }, [
    clearActiveDrag,
    clearErrorTimer,
    containerRef,
    enabled,
    pasteNativePaths,
    ptyId,
  ]);

  const onDragEnter: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!enabled) {
        return;
      }
      const resourceDrag = event.dataTransfer.types.includes(
        SVODE_RESOURCE_MIME,
      );
      const fileDrag = event.dataTransfer.types.includes("Files");
      if (!resourceDrag && !fileDrag) return;
      event.preventDefault();
      event.stopPropagation();
      clearErrorTimer();
      if (resourceDrag) {
        setDropOverlay({ kind: "active", count: 1 });
        return;
      }

      const itemCount = Array.from(event.dataTransfer.items).filter(
        (item) => item.kind === "file",
      ).length;
      setDropOverlay({ kind: "active", count: Math.max(1, itemCount) });
      if (nativeFilePathsRef.current) return;
      const token = ++nativeFileDragTokenRef.current;
      const pathsPromise = readCachedNativeFilePaths();
      void pathsPromise.then((paths) => {
        if (
          token !== nativeFileDragTokenRef.current ||
          !mountedRef.current ||
          !latestSessionRef.current.enabled ||
          paths.length === 0
        ) {
          return;
        }
        setDropOverlay({ kind: "active", count: paths.length });
      });
    },
    [clearErrorTimer, enabled, readCachedNativeFilePaths],
  );

  const onDragOver: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (
        !enabled ||
        (!event.dataTransfer.types.includes(SVODE_RESOURCE_MIME) &&
          !event.dataTransfer.types.includes("Files"))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
    },
    [enabled],
  );

  const onDragLeave: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      clearActiveDrag();
    },
    [clearActiveDrag],
  );

  const onDrop: DragEventHandler<HTMLDivElement> = useCallback(
    (event) => {
      if (!enabled) return;
      const resourceDrag = event.dataTransfer.types.includes(
        SVODE_RESOURCE_MIME,
      );
      const fileDrag = event.dataTransfer.types.includes("Files");
      if (!resourceDrag && !fileDrag) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      if (resourceDrag) {
        const serialized = event.dataTransfer.getData(SVODE_RESOURCE_MIME);
        clearActiveDrag();
        void pasteResource(serialized);
        return;
      }

      const droppedFiles = Array.from(event.dataTransfer.files);
      const cachedNativePathsPromise = readCachedNativeFilePaths();
      // File promises can publish their URL only when the drop is accepted.
      // Start a second read while the system drag session is still current.
      const dropNativePathsPromise = readNativeFileDragPaths().catch((error) => {
        console.warn("Failed to read native file paths on drop:", error);
        return [];
      });
      const nativePathsPromise = Promise.all([
        cachedNativePathsPromise,
        dropNativePathsPromise,
      ]).then(([cachedPaths, dropPaths]) => [
        ...new Set([...cachedPaths, ...dropPaths]),
      ]);
      const requestedPtyId = ptyId;
      clearActiveDrag();
      void nativePathsPromise
        .then((nativePaths) =>
          resolveDroppedFilePaths(nativePaths, droppedFiles),
        )
        .then((paths) => {
          if (!requestedPtyId || !requestIsCurrent(requestedPtyId)) return;
          if (paths.length === 0) {
            showError();
            return;
          }
          void pasteNativePaths(paths);
        })
        .catch((error) => {
          if (!requestedPtyId || !requestIsCurrent(requestedPtyId)) return;
          console.warn("Failed to materialize terminal file drop:", error);
          showError();
        });
    },
    [
      clearActiveDrag,
      enabled,
      pasteNativePaths,
      pasteResource,
      ptyId,
      readCachedNativeFilePaths,
      requestIsCurrent,
      showError,
    ],
  );

  return {
    dropOverlay: enabled ? dropOverlay : null,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  };
}
