import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEventHandler,
  type RefObject,
} from "react";
import {
  onNativeFileDrop,
  readNativeFileDragPaths,
  readWebViewDroppedFilePaths,
  resolveDroppedFilePaths,
  type LogicalPoint,
} from "@/platform/native/file-drop";
import {
  EMPTY_NATIVE_DROP_TARGET_STATE,
  isPointOnDropTarget,
  reduceNativeDropTarget,
  type NativeDropTargetState,
} from "../lib/drop-target";
import {
  parseSvodeDraggedResource,
  SVODE_RESOURCE_MIME,
  type SvodeDraggedResource,
} from "../model/resource-drag";

/** What a drop brought: files of the OS by durable path, or a sidebar resource. */
export type DroppedResources =
  | { kind: "paths"; paths: string[] }
  | { kind: "resource"; resource: SvodeDraggedResource };

export type ResourceDropOverlayState =
  | { kind: "active"; count: number }
  /** The drop is refused for a reason known before the release. */
  | { kind: "refused"; reason: string }
  /** The drop could not be taken; null when the consumer names no reason. */
  | { kind: "error"; reason: string | null }
  | null;

export interface ResourceDropHandlers {
  onDragEnter: DragEventHandler<HTMLElement>;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
}

interface UseResourceDropTargetOptions {
  containerRef: RefObject<HTMLElement | null>;
  /** The target takes drops at all. */
  enabled: boolean;
  /** Why a drop is refused now: the overlay says it and a drop does nothing. */
  refusal?: string | null;
  /**
   * Takes what was dropped at `point`, in client coordinates. A rejection
   * shows the error overlay.
   */
  onDrop: (dropped: DroppedResources, point: LogicalPoint) => Promise<void>;
}

const ERROR_VISIBLE_MS = 2500;

/** A drag that carries files of the OS or a sidebar resource. */
export function isResourceDrag(dataTransfer: DataTransfer): boolean {
  return (
    dataTransfer.types.includes(SVODE_RESOURCE_MIME) ||
    dataTransfer.types.includes("Files")
  );
}

/**
 * A surface that takes files of the OS and sidebar resources dropped on it.
 * The DOM drag lifecycle decides the target where the WebView keeps it
 * (macOS, Windows): paths of the system drag session are read from the
 * backend on macOS and from the dropped files by WebView2 on Windows, and
 * promised, ephemeral or virtual files are saved first. Where the native
 * handler of Tauri owns the drag (Linux), the window-level drop goes only
 * to the surface under the drop point.
 */
export function useResourceDropTarget({
  containerRef,
  enabled,
  refusal = null,
  onDrop,
}: UseResourceDropTargetOptions): {
  overlay: ResourceDropOverlayState;
  handlers: ResourceDropHandlers;
} {
  const [overlay, setOverlay] = useState<ResourceDropOverlayState>(null);
  const errorTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const latestRef = useRef({ enabled, refusal, onDrop });
  const nativeDropTargetRef = useRef<NativeDropTargetState>(
    EMPTY_NATIVE_DROP_TARGET_STATE,
  );
  const nativeFilePathsRef = useRef<Promise<string[]> | null>(null);
  const nativeFileDragTokenRef = useRef(0);

  useEffect(() => {
    latestRef.current = { enabled, refusal, onDrop };
  }, [enabled, onDrop, refusal]);

  const clearErrorTimer = useCallback(() => {
    if (errorTimerRef.current !== null) {
      window.clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
  }, []);

  const showError = useCallback(
    (reason: string | null) => {
      if (!mountedRef.current) return;
      clearErrorTimer();
      setOverlay({ kind: "error", reason });
      errorTimerRef.current = window.setTimeout(() => {
        setOverlay(null);
        errorTimerRef.current = null;
      }, ERROR_VISIBLE_MS);
    },
    [clearErrorTimer],
  );

  const showDragging = useCallback((count: number) => {
    const reason = latestRef.current.refusal;
    setOverlay(reason ? { kind: "refused", reason } : { kind: "active", count });
  }, []);

  const clearActiveDrag = useCallback(() => {
    nativeFileDragTokenRef.current += 1;
    nativeFilePathsRef.current = null;
    nativeDropTargetRef.current = EMPTY_NATIVE_DROP_TARGET_STATE;
    if (!mountedRef.current) return;
    setOverlay((current) =>
      current?.kind === "active" || current?.kind === "refused" ? null : current,
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearErrorTimer();
    };
  }, [clearErrorTimer]);

  /**
   * Hands a drop to the consumer that was current when it was released, so
   * a consumer that changed meanwhile can tell the drop is not its own.
   */
  const deliver = useCallback(
    (
      dropped: DroppedResources,
      point: LogicalPoint,
      take = latestRef.current.onDrop,
    ) => {
      const latest = latestRef.current;
      if (!mountedRef.current || !latest.enabled) return;
      if (latest.refusal) {
        showError(latest.refusal);
        return;
      }
      void take(dropped, point).catch((error: unknown) => {
        console.warn("Failed to take a drop:", error);
        showError(null);
      });
    },
    [showError],
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
    if (!enabled) return;
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
        setOverlay((current) => (current?.kind === "error" ? current : null));
        return;
      }

      const container = containerRef.current;
      if (event.type === "enter") clearErrorTimer();
      const inside =
        container !== null && isPointOnDropTarget(event.position, container);
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
      if (targetState.overlayCount === null) setOverlay(null);
      else showDragging(targetState.overlayCount);

      if (event.type === "drop") {
        setOverlay(null);
        if (inside && event.paths.length > 0) {
          deliver({ kind: "paths", paths: event.paths }, event.position);
        }
      }
    })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => {
        console.warn("Failed to listen for native file drops:", error);
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
    deliver,
    enabled,
    showDragging,
  ]);

  const onDragEnter: DragEventHandler<HTMLElement> = useCallback(
    (event) => {
      if (!enabled) return;
      const resourceDrag = event.dataTransfer.types.includes(
        SVODE_RESOURCE_MIME,
      );
      const fileDrag = event.dataTransfer.types.includes("Files");
      if (!resourceDrag && !fileDrag) return;
      event.preventDefault();
      event.stopPropagation();
      clearErrorTimer();
      if (resourceDrag) {
        showDragging(1);
        return;
      }

      const itemCount = Array.from(event.dataTransfer.items).filter(
        (item) => item.kind === "file",
      ).length;
      showDragging(Math.max(1, itemCount));
      if (nativeFilePathsRef.current) return;
      const token = ++nativeFileDragTokenRef.current;
      void readCachedNativeFilePaths().then((paths) => {
        if (
          token !== nativeFileDragTokenRef.current ||
          !mountedRef.current ||
          !latestRef.current.enabled ||
          paths.length === 0
        ) {
          return;
        }
        showDragging(paths.length);
      });
    },
    [clearErrorTimer, enabled, readCachedNativeFilePaths, showDragging],
  );

  const onDragOver: DragEventHandler<HTMLElement> = useCallback(
    (event) => {
      if (!enabled || !isResourceDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = latestRef.current.refusal ? "none" : "copy";
    },
    [enabled],
  );

  const onDragLeave: DragEventHandler<HTMLElement> = useCallback(
    (event) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      // WebKit leaves `relatedTarget` null when the drag moves between
      // children, so a leave inside the surface's bounds is not one.
      if (
        event.relatedTarget === null &&
        isPointOnDropTarget(
          { x: event.clientX, y: event.clientY },
          event.currentTarget,
        )
      ) {
        return;
      }
      clearActiveDrag();
    },
    [clearActiveDrag],
  );

  const onDropEvent: DragEventHandler<HTMLElement> = useCallback(
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
      const point = { x: event.clientX, y: event.clientY };
      if (resourceDrag) {
        const resource = parseSvodeDraggedResource(
          event.dataTransfer.getData(SVODE_RESOURCE_MIME),
        );
        clearActiveDrag();
        if (resource) deliver({ kind: "resource", resource }, point);
        else showError(null);
        return;
      }

      const droppedFiles = Array.from(event.dataTransfer.files);
      const cachedNativePathsPromise = readCachedNativeFilePaths();
      // File promises can publish their URL only when the drop is accepted.
      // Start a second read while the system drag session is still current.
      // WebView2 hands the paths of the dropped files themselves.
      const dropNativePathsPromise = Promise.all([
        readNativeFileDragPaths().catch((error) => {
          console.warn("Failed to read native file paths on drop:", error);
          return [];
        }),
        readWebViewDroppedFilePaths(droppedFiles),
      ]).then(([dragPaths, webViewPaths]) => [...dragPaths, ...webViewPaths]);
      const nativePathsPromise = Promise.all([
        cachedNativePathsPromise,
        dropNativePathsPromise,
      ]).then(([cachedPaths, dropPaths]) => [
        ...new Set([...cachedPaths, ...dropPaths]),
      ]);
      clearActiveDrag();
      if (latestRef.current.refusal) {
        showError(latestRef.current.refusal);
        return;
      }
      const take = latestRef.current.onDrop;
      void nativePathsPromise
        .then((nativePaths) =>
          resolveDroppedFilePaths(nativePaths, droppedFiles),
        )
        .then((paths) => {
          if (paths.length === 0) {
            showError(null);
            return;
          }
          deliver({ kind: "paths", paths }, point, take);
        })
        .catch((error) => {
          console.warn("Failed to materialize a file drop:", error);
          showError(null);
        });
    },
    [
      clearActiveDrag,
      deliver,
      enabled,
      readCachedNativeFilePaths,
      showError,
    ],
  );

  return {
    overlay: enabled ? overlay : null,
    handlers: {
      onDragEnter,
      onDragOver,
      onDragLeave,
      onDrop: onDropEvent,
    },
  };
}
