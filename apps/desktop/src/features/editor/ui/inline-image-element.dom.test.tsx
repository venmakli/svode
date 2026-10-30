import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";

if (process.env.SVODE_INLINE_IMAGE_ELEMENT_DOM !== "1") {
  test("inline image element DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_INLINE_IMAGE_ELEMENT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const { createTestDom } = await import("@/shared/testing/dom");
  const dom = await createTestDom();
  // Slate uses these when an editable mounts.
  for (const key of [
    "Document",
    "ShadowRoot",
    "Text",
    "Range",
    "FocusEvent",
    "MouseEvent",
    "KeyboardEvent",
    "InputEvent",
  ] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: window[key],
    });
  }

  const { createPlateEditor, Plate, PlateContent } =
    await import("platejs/react");
  const { ImagePlugin, ImagePreviewStore } =
    await import("@platejs/media/react");
  const { MediaAdapterProvider, defaultMediaAdapter } =
    await import("@/components/ui/media-adapter");
  const { InlineImagePlugin } = await import("../plate/inline-image-plugin");

  // `pending.png` stays unresolved; other addresses resolve to the webview.
  const adapter = {
    ...defaultMediaAdapter,
    useResolvedUrl: (url: string | undefined) =>
      url && url !== "pending.png" ? `asset://localhost/${url}` : undefined,
  };

  const image = (url: string, alt: string) => ({
    type: "inline_img",
    url,
    alt,
    children: [{ text: "" }],
  });

  const editor = createPlateEditor({
    plugins: [ImagePlugin, InlineImagePlugin],
    value: [
      {
        type: "p",
        children: [
          { text: "Before " },
          image("./logo.png", "logo"),
          { text: " and " },
          image("shots/my%20shot.png", ""),
          { text: " then " },
          image("pending.png", "pending"),
          { text: " after." },
        ],
      },
      { type: "img", url: "block.png", children: [{ text: "" }] },
    ],
  });

  await dom.render(
    <MediaAdapterProvider adapter={adapter}>
      <Plate editor={editor}>
        <PlateContent />
      </Plate>
    </MediaAdapterProvider>,
  );

  function imageOf(alt: string) {
    return dom.document.querySelector<HTMLImageElement>(
      `[data-slate-editor] img[alt="${alt}"]`,
    );
  }

  test("the image stands in the line with its alt and the resolved address", () => {
    const img = imageOf("logo")!;
    expect(img.getAttribute("src")).toBe("asset://localhost/./logo.png");
    const paragraph = dom.document.querySelector("[data-slate-editor] > *")!;
    expect(paragraph.contains(img)).toBe(true);
    expect(paragraph.textContent?.includes("Before ")).toBe(true);
    expect(paragraph.textContent?.includes(" after.")).toBe(true);
    expect(img.closest("[data-slate-inline]") !== null).toBe(true);
    expect(img.closest("[contenteditable=false]") !== null).toBe(true);
  });

  test("an image without alt is named by its file", () => {
    expect(imageOf("my shot.png") !== null).toBe(true);
  });

  test("a placeholder stands in while the address resolves or the file loads", async () => {
    const pending = dom.document.querySelector(
      '[data-slot=skeleton][aria-label="pending"]',
    );
    expect(pending?.getAttribute("role")).toBe("img");
    expect(imageOf("pending")).toBeNull();

    const frame = imageOf("logo")!.parentElement!;
    expect(frame.querySelector("[data-slot=skeleton]") !== null).toBe(true);
    await act(async () => {
      imageOf("logo")!.dispatchEvent(new window.Event("load"));
    });
    expect(frame.querySelector("[data-slot=skeleton]")).toBeNull();
  });

  test("a file that does not load shows the broken state with its name", async () => {
    const frame = imageOf("my shot.png")!.parentElement!;
    await act(async () => {
      imageOf("my shot.png")!.dispatchEvent(new window.Event("error"));
    });
    const broken = frame.querySelector('[role="img"]')!;
    expect(broken.getAttribute("aria-label")).toBe(
      "Image not loaded: my shot.png",
    );
    expect(broken.querySelector("svg") !== null).toBe(true);
    expect(broken.textContent).toBe("my shot.png");
    expect(imageOf("my shot.png")).toBeNull();
  });

  test("a double click opens the image preview", async () => {
    await act(async () => {
      imageOf("logo")!.dispatchEvent(
        new window.MouseEvent("dblclick", { bubbles: true }),
      );
    });
    expect(ImagePreviewStore.get("openEditorId")).toBe(editor.id);
    expect(ImagePreviewStore.get("currentPreview")?.url).toBe("./logo.png");
    expect(
      ImagePreviewStore.get("previewList").map((item) => item.url),
    ).toEqual([
      "./logo.png",
      "shots/my%20shot.png",
      "pending.png",
      "block.png",
    ]);
  });
}
