import * as bunTest from "bun:test";
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

// The toast and module mocks must not reach other test files of the process.
const isolated = process.env.SVODE_EDITOR_UPLOAD_DOM === "1";
if (!isolated) {
  test("editor file insertion refusal DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_EDITOR_UPLOAD_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
}
const domTest = (isolated ? test : () => undefined) as typeof test;

const toastErrors: string[] = [];
let importRefusal: unknown = null;

if (isolated) {
  const dom = new JSDOM("<!doctype html><div id='app'></div>", {
    url: "http://localhost/",
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  const { mock } = bunTest;
  const realSonner = await import("sonner");
  mock.module("sonner", () => ({
    ...realSonner,
    toast: Object.assign(() => undefined, realSonner.toast, {
      error: (message: string) => {
        toastErrors.push(message);
      },
    }),
  }));
  mock.module("../api/editor-media-api", () => ({
    importEditorMediaAsset: () => Promise.reject(importRefusal),
    sourcePathForEditorMediaFile: () => "/Users/me/photo.png",
  }));
  mock.module("./use-resolved-asset-url", () => ({
    useEditorDocumentContext: () => ({
      documentPath: "Plan.md",
      projectPath: "/project",
      sourceSpaceId: null,
    }),
  }));
}

domTest(
  "a refused file insertion shows the text of the attachments surface",
  async () => {
    const { useUploadFile } = await import("./use-upload-file");
    const { setLocale } = await import("@/paraglide/runtime");
    let upload: ((file: File) => Promise<unknown>) | null = null;
    function Harness({
      onUpload,
    }: {
      onUpload(value: (file: File) => Promise<unknown>): void;
    }) {
      onUpload(useUploadFile().uploadFile);
      return null;
    }
    const root = createRoot(document.getElementById("app")!);
    await act(async () =>
      root.render(
        <Harness
          onUpload={(value) => {
            upload = value;
          }}
        />,
      ),
    );
    const insert = () =>
      act(async () => {
        await upload!(new File(["png"], "photo.png", { type: "image/png" }));
      });

    try {
      importRefusal = {
        kind: "lfs_not_ready",
        reason: "lfs_tooling_unavailable",
        code: "LFS_TOOLING_UNAVAILABLE",
        message: "Git LFS route is not ready: git-lfs is not installed",
      };
      await insert();
      setLocale("ru", { reload: false });
      try {
        await insert();
      } finally {
        setLocale("en", { reload: false });
      }
      importRefusal = "Storage: the source file cannot be read";
      await insert();

      expect(toastErrors).toEqual([
        "File not added: Git LFS is not ready on this device — install git-lfs or reinstall Svode",
        "Файл не добавлен: Git LFS не готов на этом устройстве — установите git-lfs или переустановите Svode",
        "File not added: Storage: the source file cannot be read",
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
