import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

if (process.env.SVODE_WEBVIEW_DROP_DOM !== "1") {
  test("WebView2 dropped file paths", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_WEBVIEW_DROP_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
  });
  Object.assign(globalThis, { window: dom.window });
  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc(() => null, { shouldMockEvents: true });
  const { emit } = await import("@/platform/native/events");
  const { readWebViewDroppedFilePaths } = await import("./file-drop");

  const EVENT = "webview-file-drop-paths";
  const files = [new File(["a"], "a.png"), new File([], "tasks")];

  /** What the host does with a drop message: answers it, or not. */
  let answer: (
    message: { svodeFileDrop: string },
    objects: unknown[],
  ) => void = () => undefined;
  const posted: { message: unknown; objects: unknown[] }[] = [];
  function installHost(host: unknown) {
    Object.assign(globalThis, {
      chrome: host === null ? undefined : { webview: host },
    });
  }
  installHost({
    postMessageWithAdditionalObjects(
      message: { svodeFileDrop: string },
      objects: ArrayLike<unknown>,
    ) {
      posted.push({ message, objects: Array.from(objects) });
      answer(message, Array.from(objects));
    },
  });

  test("the host answers a drop with the paths of its files, in order", async () => {
    posted.length = 0;
    answer = (message) => {
      // Another drop's answer is not this one's.
      void emit(EVENT, { id: "drop-other", paths: ["C:\\other.txt", "C:\\x"] });
      void emit(EVENT, {
        id: message.svodeFileDrop,
        paths: ["C:\\Users\\me\\a.png", "C:\\Users\\me\\tasks"],
      });
    };
    expect(await readWebViewDroppedFilePaths(files)).toEqual([
      "C:\\Users\\me\\a.png",
      "C:\\Users\\me\\tasks",
    ]);
    expect(posted.length).toBe(1);
    expect(Object.keys(posted[0].message as object)).toEqual(["svodeFileDrop"]);
    expect(posted[0].objects).toEqual(files);
  });

  test("a drop without a path for every file, or without an answer, has none", async () => {
    answer = (message) =>
      void emit(EVENT, {
        id: message.svodeFileDrop,
        paths: ["C:\\Users\\me\\a.png"],
      });
    expect(await readWebViewDroppedFilePaths(files)).toEqual([]);
    answer = (message) =>
      void emit(EVENT, { id: message.svodeFileDrop, paths: [] });
    expect(await readWebViewDroppedFilePaths(files)).toEqual([]);
    answer = () => undefined;
    const started = Date.now();
    expect(await readWebViewDroppedFilePaths(files, 50)).toEqual([]);
    expect(Date.now() - started >= 45).toBe(true);
    // A host that refuses the files gives none.
    answer = () => {
      throw new Error("not supported");
    };
    expect(await readWebViewDroppedFilePaths(files)).toEqual([]);
  });

  test("outside WebView2 nothing is posted", async () => {
    posted.length = 0;
    installHost(null);
    expect(await readWebViewDroppedFilePaths(files)).toEqual([]);
    installHost({});
    expect(await readWebViewDroppedFilePaths(files)).toEqual([]);
    expect(posted).toEqual([]);
  });
}
