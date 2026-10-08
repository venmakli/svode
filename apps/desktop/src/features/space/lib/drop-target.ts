import type { LogicalPoint } from "@/platform/native/file-drop";

export interface DropTargetRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface NativeDropTargetState {
  pathCount: number;
  overlayCount: number | null;
}

export type NativeDropTargetEvent =
  | { type: "enter"; pathCount: number }
  | { type: "over" | "drop" | "leave" };

export const EMPTY_NATIVE_DROP_TARGET_STATE: NativeDropTargetState = {
  pathCount: 0,
  overlayCount: null,
};

export function isPointInsideDropTarget(
  point: LogicalPoint,
  rect: DropTargetRect,
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

/**
 * Whether a native drop point lies on `target`: inside its bounds and not
 * under another surface drawn over it, such as a peek over a terminal.
 */
export function isPointOnDropTarget(
  point: LogicalPoint,
  target: Element,
  ownerDocument: Pick<Document, "elementFromPoint"> = target.ownerDocument,
): boolean {
  if (!isPointInsideDropTarget(point, target.getBoundingClientRect())) {
    return false;
  }
  const hit = ownerDocument.elementFromPoint?.(point.x, point.y) ?? null;
  return hit === null || target.contains(hit);
}

export function reduceNativeDropTarget(
  state: NativeDropTargetState,
  event: NativeDropTargetEvent,
  inside: boolean,
): NativeDropTargetState {
  if (event.type === "drop" || event.type === "leave") {
    return EMPTY_NATIVE_DROP_TARGET_STATE;
  }

  const pathCount =
    event.type === "enter" ? Math.max(0, event.pathCount) : state.pathCount;
  return {
    pathCount,
    overlayCount: inside && pathCount > 0 ? pathCount : null,
  };
}
