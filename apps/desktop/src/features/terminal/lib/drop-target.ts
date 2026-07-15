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
