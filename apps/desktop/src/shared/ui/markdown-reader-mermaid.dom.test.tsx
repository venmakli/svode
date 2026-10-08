import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

// Mermaid binds DOMPurify to the window it finds when it loads, so the reader
// is imported only after the DOM globals exist, in a process of its own.
if (process.env.SVODE_MARKDOWN_READER_MERMAID_DOM !== "1") {
  test("Markdown reader Mermaid DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_MARKDOWN_READER_MERMAID_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/",
    pretendToBeVisual: true,
  });
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    SVGElement: dom.window.SVGElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    DOMParser: dom.window.DOMParser,
    CSSStyleSheet: dom.window.CSSStyleSheet,
    MutationObserver: dom.window.MutationObserver,
    IntersectionObserver: class {
      constructor(
        private readonly callback: (
          entries: { isIntersecting: boolean }[],
          observer: unknown,
        ) => void,
      ) {}
      disconnect() {}
      observe() {
        this.callback([{ isIntersecting: true }], this);
      }
      takeRecords() {
        return [];
      }
      unobserve() {}
    },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  // JSDOM has no layout; Mermaid only needs some text size to place labels.
  Object.assign(dom.window.SVGElement.prototype, {
    getBBox: () => ({ x: 0, y: 0, width: 40, height: 16 }),
    getComputedTextLength: () => 40,
  });

  const { MarkdownReader } = await import("./markdown-reader");
  const policy = {};

  async function renderReader(content: string) {
    const container = dom.window.document.createElement("div");
    dom.window.document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<MarkdownReader content={content} policy={policy} />);
    });
    return {
      container,
      async unmount() {
        await act(async () => root.unmount());
        container.remove();
      },
    };
  }

  async function waitFor<T>(read: () => T | null | undefined): Promise<T> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const value = read();
      if (value) return value;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
    }
    throw new Error("Timed out waiting for the Mermaid block");
  }

  const hostileDiagram = [
    "```mermaid",
    "flowchart TD",
    '  A["<span onmouseover=alert(1)>hover</span> <a href=javascript:alert(2)>link</a> <script>alert(3)</script>"] --> B',
    "  click A readerCallback",
    '  click B href "javascript:alert(4)"',
    "```",
  ].join("\n");

  test("Mermaid draws a diagram without click handlers or HTML from its description", async () => {
    const calls: string[] = [];
    Object.assign(dom.window, {
      readerCallback: () => calls.push("callback"),
    });
    const reader = await renderReader(hostileDiagram);

    try {
      const svg = await waitFor(() =>
        reader.container.querySelector('[data-streamdown="mermaid"] svg'),
      );
      const elements = [svg, ...Array.from(svg.querySelectorAll("*"))];

      expect(
        elements.flatMap((element) =>
          element
            .getAttributeNames()
            .filter((name) => /^on/i.test(name) || /href$/i.test(name)),
        ),
      ).toEqual([]);
      expect(svg.querySelector("script")).toBeNull();
      expect(svg.outerHTML.includes("javascript:")).toBe(false);
      expect(svg.outerHTML.includes("alert(")).toBe(false);
      expect(
        Array.from(svg.querySelectorAll(".nodeLabel")).map(
          (label) => label.textContent,
        ),
      ).toEqual(["hover link ", "B"]);

      // The click directives were read, yet nothing is bound to them.
      expect(svg.querySelectorAll(".node.clickable").length).toBe(2);
      for (const node of Array.from(svg.querySelectorAll(".node"))) {
        await act(async () => {
          node.dispatchEvent(
            new dom.window.MouseEvent("click", { bubbles: true }),
          );
        });
      }
      expect(calls).toEqual([]);
      expect(dom.window.location.href).toBe("http://localhost/");
    } finally {
      await reader.unmount();
    }
  });

  test("Mermaid follows the app theme applied on the document root", async () => {
    const content = "```mermaid\nflowchart TD\n  A --> B\n```";
    const root = dom.window.document.documentElement;

    root.classList.add("light");
    const light = await renderReader(content);
    const lightSvg = await waitFor(() =>
      light.container.querySelector('[data-streamdown="mermaid"] svg'),
    );
    expect(lightSvg.outerHTML.toLowerCase().includes("#ececff")).toBe(true);

    await act(async () => {
      root.classList.replace("light", "dark");
    });
    const darkSvg = await waitFor(() => {
      const svg = light.container.querySelector(
        '[data-streamdown="mermaid"] svg',
      );
      return svg && !svg.outerHTML.toLowerCase().includes("#ececff")
        ? svg
        : null;
    });
    expect(darkSvg.outerHTML.toLowerCase().includes("#1f2020")).toBe(true);

    await light.unmount();
    root.classList.remove("dark");
  });

  test("Mermaid shows the source with the reason when the description does not parse", async () => {
    const source = 'flowchart TD\n  A["<img src=x onerror=alert(1)>"] -->';
    const reader = await renderReader(`\`\`\`mermaid\n${source}\n\`\`\``);

    try {
      const fallback = await waitFor(() =>
        reader.container.querySelector<HTMLElement>(
          '[data-streamdown="mermaid-block"] [data-markdown-reader-diagram-error]',
        ),
      );
      const reason = fallback.querySelector("p");
      expect(reason?.textContent).toBe(
        "The diagram could not be drawn: Parse error on line 4:",
      );
      expect(reason?.className.includes("text-destructive")).toBe(true);
      expect(fallback.querySelector("pre")?.textContent?.trimEnd()).toBe(
        source,
      );
      expect(fallback.querySelector("img")).toBeNull();
      expect(fallback.outerHTML.includes("red-")).toBe(false);
      expect(reader.container.textContent?.includes("Mermaid Error")).toBe(
        false,
      );
      expect(reader.container.querySelector("svg[id^='mermaid-']")).toBeNull();
    } finally {
      await reader.unmount();
    }
  });

  test("a wheel over a diagram scrolls the page instead of zooming the diagram", async () => {
    const reader = await renderReader(
      "```mermaid\nflowchart TD\n  A --> B\n```",
    );

    try {
      const svg = await waitFor(() =>
        reader.container.querySelector('[data-streamdown="mermaid"] svg'),
      );
      const wheel = new dom.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
      });
      await act(async () => {
        svg.dispatchEvent(wheel);
      });
      expect(wheel.defaultPrevented).toBe(false);
      const surface = reader.container.querySelector<HTMLElement>(
        '[data-streamdown="mermaid"] [role="application"]',
      );
      expect(surface?.style.transform).toBe("translate(0px, 0px) scale(1)");
    } finally {
      await reader.unmount();
    }
  });

  test("Mermaid offers copying its source and code blocks keep no controls", async () => {
    const reader = await renderReader(
      "```mermaid\nflowchart TD\n  A --> B\n```\n\n```ts\nconst value = 1;\n```",
    );

    try {
      const actions = await waitFor(() =>
        reader.container.querySelector(
          '[data-streamdown="mermaid-block-actions"]',
        ),
      );
      const buttons = Array.from(actions.querySelectorAll("button"));
      expect(buttons.length).toBe(1);
      expect(buttons[0]?.dataset.streamdown).toBe("code-block-copy-button");
      expect(buttons[0]?.title).toBe("Copy code");
      expect(
        reader.container.querySelectorAll(
          '[data-streamdown="code-block-copy-button"]',
        ).length,
      ).toBe(1);
    } finally {
      await reader.unmount();
    }
  });
}
