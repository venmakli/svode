import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface LogicalPoint {
  x: number;
  y: number;
}

export type NativeFileDropEvent =
  | { type: "enter"; paths: string[]; position: LogicalPoint }
  | { type: "over"; position: LogicalPoint }
  | { type: "drop"; paths: string[]; position: LogicalPoint }
  | { type: "leave" };

export function physicalToLogicalPoint(
  position: { x: number; y: number },
  scaleFactor: number,
): LogicalPoint {
  const safeScaleFactor = scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: position.x / safeScaleFactor,
    y: position.y / safeScaleFactor,
  };
}

function normalizeDragDropEvent(
  event: DragDropEvent,
  scaleFactor: number,
): NativeFileDropEvent {
  if (event.type === "leave") return event;
  const position = physicalToLogicalPoint(event.position, scaleFactor);
  if (event.type === "over") return { type: event.type, position };
  return { type: event.type, paths: event.paths, position };
}

export async function onNativeFileDrop(
  handler: (event: NativeFileDropEvent) => void,
): Promise<UnlistenFn> {
  const appWindow = getCurrentWindow();
  let scaleFactor = await appWindow.scaleFactor();
  const unlistenScale = await appWindow.onScaleChanged(({ payload }) => {
    scaleFactor = payload.scaleFactor;
  });

  try {
    const unlistenDrop = await getCurrentWebview().onDragDropEvent(
      ({ payload }) => {
        handler(normalizeDragDropEvent(payload, scaleFactor));
      },
    );
    return () => {
      unlistenDrop();
      unlistenScale();
    };
  } catch (error) {
    unlistenScale();
    throw error;
  }
}
