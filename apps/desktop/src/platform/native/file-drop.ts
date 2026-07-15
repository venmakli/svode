import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { invokeCommand } from "@/platform/native/invoke";

const DROP_FILE_NAME_HEADER = "x-svode-drop-file-name";
export const MAX_MATERIALIZED_DROP_BYTES = 100 * 1024 * 1024;

export interface LogicalPoint {
  x: number;
  y: number;
}

export type NativeDropCoordinatePlatform = "macos" | "windows" | "linux";

export type NativeFileDropEvent =
  | { type: "enter"; paths: string[]; position: LogicalPoint }
  | { type: "over"; position: LogicalPoint }
  | { type: "drop"; paths: string[]; position: LogicalPoint }
  | { type: "leave" };

export function nativeDropPointToLogical(
  position: { x: number; y: number },
  scaleFactor: number,
  platform: NativeDropCoordinatePlatform,
): LogicalPoint {
  // Wry 0.54 reports Cocoa/GTK drop positions in logical points but reports
  // WebView2 positions in physical pixels. Tauri types all three as physical.
  if (platform !== "windows") return position;
  const safeScaleFactor = scaleFactor > 0 ? scaleFactor : 1;
  return {
    x: position.x / safeScaleFactor,
    y: position.y / safeScaleFactor,
  };
}

function normalizeDragDropEvent(
  event: DragDropEvent,
  scaleFactor: number,
  platform: NativeDropCoordinatePlatform,
): NativeFileDropEvent {
  if (event.type === "leave") return event;
  const position = nativeDropPointToLogical(
    event.position,
    scaleFactor,
    platform,
  );
  if (event.type === "over") return { type: event.type, position };
  return { type: event.type, paths: event.paths, position };
}

export async function onNativeFileDrop(
  handler: (event: NativeFileDropEvent) => void,
): Promise<UnlistenFn> {
  const appWindow = getCurrentWindow();
  const platform = currentCoordinatePlatform();
  let scaleFactor = await appWindow.scaleFactor();
  const unlistenScale = await appWindow.onScaleChanged(({ payload }) => {
    scaleFactor = payload.scaleFactor;
  });

  try {
    const unlistenDrop = await getCurrentWebview().onDragDropEvent(
      ({ payload }) => {
        handler(normalizeDragDropEvent(payload, scaleFactor, platform));
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

export function readNativeFileDragPaths(): Promise<string[]> {
  return invokeCommand<string[]>("native_file_drop_paths");
}

export interface DroppedFilePathMaterializer {
  fromFiles(files: readonly File[]): Promise<string[]>;
  fromNativePaths(paths: readonly string[]): Promise<string[]>;
}

const nativeDroppedFilePathMaterializer: DroppedFilePathMaterializer = {
  async fromFiles(files) {
    if (!isMaterializedFileDropWithinLimit(files)) {
      throw new Error("Dropped virtual files exceed the 100 MiB limit");
    }
    const materializedFiles: Array<{ fileName: string; bytes: Uint8Array }> = [];
    let actualBytes = 0;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      actualBytes += bytes.byteLength;
      if (actualBytes > MAX_MATERIALIZED_DROP_BYTES) {
        throw new Error("Dropped virtual files exceed the 100 MiB limit");
      }
      materializedFiles.push({
        fileName: file.name.trim() || "dropped-file",
        bytes,
      });
    }

    const paths: string[] = [];
    for (const file of materializedFiles) {
      paths.push(
        await invokeCommand<string>("materialize_file_drop", file.bytes, {
          headers: {
            [DROP_FILE_NAME_HEADER]: encodeURIComponent(file.fileName),
          },
        }),
      );
    }
    return paths;
  },
  fromNativePaths(paths) {
    return invokeCommand<string[]>("materialize_native_file_drop_paths", {
      paths: [...paths],
    });
  },
};

export function isMaterializedFileDropWithinLimit(
  files: readonly Pick<File, "size">[],
): boolean {
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_MATERIALIZED_DROP_BYTES - totalBytes) return false;
    totalBytes += file.size;
  }
  return true;
}

export function isLikelyEphemeralFileDropPath(path: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/").toLowerCase();
  const isMacTemporaryPath =
    normalizedPath.startsWith("/var/") ||
    normalizedPath.startsWith("/private/var/");
  return isMacTemporaryPath && normalizedPath.includes("screencaptureui");
}

export async function resolveDroppedFilePaths(
  nativePaths: readonly string[],
  files: readonly File[],
  materializer: DroppedFilePathMaterializer = nativeDroppedFilePathMaterializer,
): Promise<string[]> {
  const hasEphemeralNativePath = nativePaths.some(
    isLikelyEphemeralFileDropPath,
  );
  const hasIncompleteNativePaths =
    files.length > 0 && nativePaths.length < files.length;
  if (
    nativePaths.length > 0 &&
    !hasEphemeralNativePath &&
    !hasIncompleteNativePaths
  ) {
    return [...nativePaths];
  }
  if (files.length > 0 && files.length >= nativePaths.length) {
    return materializer.fromFiles(files);
  }
  if (nativePaths.length > 0) {
    return materializer.fromNativePaths(nativePaths);
  }
  return [];
}

export function nativeDropCoordinatePlatform(
  platform: string,
  userAgent: string,
): NativeDropCoordinatePlatform {
  const normalizedPlatform = platform.toLowerCase();
  const normalizedUserAgent = userAgent.toLowerCase();
  if (
    normalizedPlatform.includes("mac") ||
    normalizedUserAgent.includes("macintosh")
  ) {
    return "macos";
  }
  if (
    normalizedPlatform.includes("win") ||
    normalizedUserAgent.includes("windows")
  ) {
    return "windows";
  }
  return "linux";
}

function currentCoordinatePlatform(): NativeDropCoordinatePlatform {
  if (typeof navigator === "undefined") return "linux";
  return nativeDropCoordinatePlatform(navigator.platform, navigator.userAgent);
}
