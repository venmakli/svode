import { expect, test } from "bun:test";
import {
  isLikelyEphemeralFileDropPath,
  isMaterializedFileDropWithinLimit,
  MAX_MATERIALIZED_DROP_BYTES,
  nativeDropCoordinatePlatform,
  nativeDropPointToLogical,
  resolveDroppedFilePaths,
  type DroppedFilePathMaterializer,
} from "./file-drop";

function createMaterializer(): DroppedFilePathMaterializer & {
  fileCalls: File[][];
  nativePathCalls: string[][];
} {
  const fileCalls: File[][] = [];
  const nativePathCalls: string[][] = [];
  return {
    fileCalls,
    nativePathCalls,
    async fromFiles(files) {
      fileCalls.push([...files]);
      return ["/cache/Screenshot.png"];
    },
    async fromNativePaths(paths) {
      nativePathCalls.push([...paths]);
      return ["/cache/native-Screenshot.png"];
    },
  };
}

test("converts Windows physical file-drop coordinates to logical coordinates", () => {
  expect(nativeDropPointToLogical({ x: 450, y: 225 }, 1.5, "windows")).toEqual({
    x: 300,
    y: 150,
  });
});

test("keeps macOS Retina file-drop coordinates in Cocoa logical points", () => {
  expect(nativeDropPointToLogical({ x: 450, y: 225 }, 2, "macos")).toEqual({
    x: 450,
    y: 225,
  });
});

test("keeps Linux WebKit file-drop coordinates in widget logical points", () => {
  expect(nativeDropPointToLogical({ x: 450, y: 225 }, 1.5, "linux")).toEqual({
    x: 450,
    y: 225,
  });
});

test("uses a safe Windows scale for invalid scale factors", () => {
  expect(nativeDropPointToLogical({ x: 40, y: 20 }, 0, "windows")).toEqual({
    x: 40,
    y: 20,
  });
});

test("detects macOS and Windows coordinate systems from the webview", () => {
  expect(nativeDropCoordinatePlatform("MacIntel", "Mozilla/5.0")).toBe(
    "macos",
  );
  expect(nativeDropCoordinatePlatform("Win32", "Mozilla/5.0")).toBe(
    "windows",
  );
});

test("limits the complete materialized drop rather than each file", () => {
  expect(
    isMaterializedFileDropWithinLimit([
      { size: MAX_MATERIALIZED_DROP_BYTES / 2 },
      { size: MAX_MATERIALIZED_DROP_BYTES / 2 },
    ]),
  ).toBe(true);
  expect(
    isMaterializedFileDropWithinLimit([
      { size: MAX_MATERIALIZED_DROP_BYTES / 2 },
      { size: MAX_MATERIALIZED_DROP_BYTES / 2 + 1 },
    ]),
  ).toBe(false);
});

test("keeps durable native file paths without copying them", async () => {
  const materializer = createMaterializer();

  expect(
    await resolveDroppedFilePaths(
      ["/Users/kamin/Desktop/report.pdf"],
      [{} as File],
      materializer,
    ),
  ).toEqual(["/Users/kamin/Desktop/report.pdf"]);
  expect(materializer.fileCalls).toEqual([]);
  expect(materializer.nativePathCalls).toEqual([]);
});

test("materializes a promised DOM file when no native path exists", async () => {
  const materializer = createMaterializer();
  const promisedFile = { name: "Screenshot.png" } as File;

  expect(
    await resolveDroppedFilePaths([], [promisedFile], materializer),
  ).toEqual(["/cache/Screenshot.png"]);
  expect(materializer.fileCalls).toEqual([[promisedFile]]);
  expect(materializer.nativePathCalls).toEqual([]);
});

test("materializes all DOM files when native path resolution is incomplete", async () => {
  const materializer = createMaterializer();
  const firstFile = { name: "one.png" } as File;
  const secondFile = { name: "two.png" } as File;

  expect(
    await resolveDroppedFilePaths(
      ["/tmp/one.png"],
      [firstFile, secondFile],
      materializer,
    ),
  ).toEqual(["/cache/Screenshot.png"]);
  expect(materializer.fileCalls).toEqual([[firstFile, secondFile]]);
  expect(materializer.nativePathCalls).toEqual([]);
});

test("materializes macOS screenshot promise paths before they disappear", async () => {
  const materializer = createMaterializer();
  const promisedFile = { name: "Снимок экрана.png" } as File;
  const screenshotPath =
    "/var/folders/ab/cd/T/TemporaryItems/NSIRD_screencaptureui_X3ZFRi/Снимок экрана.png";

  expect(isLikelyEphemeralFileDropPath(screenshotPath)).toBe(true);
  expect(
    await resolveDroppedFilePaths(
      [screenshotPath],
      [promisedFile],
      materializer,
    ),
  ).toEqual(["/cache/Screenshot.png"]);
  expect(materializer.fileCalls).toEqual([[promisedFile]]);
  expect(materializer.nativePathCalls).toEqual([]);
});

test("does not classify a durable file merely by its screenshot-like name", () => {
  expect(
    isLikelyEphemeralFileDropPath(
      "/Users/kamin/Desktop/NSIRD_screencaptureui_notes.txt",
    ),
  ).toBe(false);
  expect(
    isLikelyEphemeralFileDropPath(
      "/private/var/folders/ab/cd/T/TemporaryItems/custom-screencaptureui/Screenshot.png",
    ),
  ).toBe(true);
});

test("copies an ephemeral native path when the webview exposes no DOM file", async () => {
  const materializer = createMaterializer();
  const screenshotPath =
    "/var/folders/ab/cd/T/TemporaryItems/NSIRD_screencaptureui_X3ZFRi/Screenshot.png";

  expect(
    await resolveDroppedFilePaths([screenshotPath], [], materializer),
  ).toEqual(["/cache/native-Screenshot.png"]);
  expect(materializer.fileCalls).toEqual([]);
  expect(materializer.nativePathCalls).toEqual([[screenshotPath]]);
});

test("returns no paths when neither native paths nor DOM files are available", async () => {
  const materializer = createMaterializer();

  expect(await resolveDroppedFilePaths([], [], materializer)).toEqual([]);
  expect(materializer.fileCalls).toEqual([]);
  expect(materializer.nativePathCalls).toEqual([]);
});
