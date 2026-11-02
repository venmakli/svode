import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_HTML_DOCUMENT_DOM !== "1") {
  test("HTML document surface DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_HTML_DOCUMENT_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html class=light><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    HTMLElement: dom.window.HTMLElement,
    HTMLIFrameElement: dom.window.HTMLIFrameElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    Event: dom.window.Event,
    CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  })) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  dom.window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  mock.module("@pierre/diffs/react", () => ({
    File: ({ file }: { file: { name: string; contents: string } }) => (
      <pre data-source-file={file.name}>{file.contents}</pre>
    ),
  }));

  const doc = dom.window.document;
  const SOURCE = "<!doctype html><title>Report</title>";

  interface Fixture {
    serveFailure: object | null;
    inspectFailure: object | null;
    sizeBytes: number;
    generation: string;
    /** Holds `html_document_serve` until it resolves. */
    serveGate: Promise<void> | null;
  }
  let fixture: Fixture;
  let calls: Array<{ command: string; args: Record<string, unknown> }>;
  let served = 0;

  function reset(overrides: Partial<Fixture> = {}) {
    fixture = {
      serveFailure: null,
      inspectFailure: null,
      sizeBytes: SOURCE.length,
      generation: "g1",
      serveGate: null,
      ...overrides,
    };
    calls = [];
  }
  reset();

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  async function setup() {
    const { mockNativeIpc } = await import("@/platform/native/testing");
    mockNativeIpc(
      async (command, args) => {
        calls.push({ command, args: (args ?? {}) as Record<string, unknown> });
        switch (command) {
          case "html_document_serve":
            if (fixture.serveGate) await fixture.serveGate;
            if (fixture.serveFailure) throw fixture.serveFailure;
            served += 1;
            return {
              capabilityToken: `token-${served}`,
              viewportUrl: `http://127.0.0.1:${4000 + served}/report.html`,
              sizeBytes: fixture.sizeBytes,
              modifiedAt: "2026-11-02T10:00:00Z",
            };
          case "document_inspect_source":
            if (fixture.inspectFailure) throw fixture.inspectFailure;
            return {
              format: "html",
              sizeBytes: fixture.sizeBytes,
              generation: fixture.generation,
              modifiedAt: "2026-11-02T10:00:00Z",
            };
          case "document_read_source":
            return new TextEncoder().encode(SOURCE);
          case "document_list_external_apps":
            return [];
          case "html_document_set_theme":
          case "html_document_revoke":
          case "list_project_openers":
            return command === "list_project_openers" ? [] : null;
          default:
            throw new Error(`Unexpected command: ${command}`);
        }
      },
      { shouldMockEvents: true },
    );
    const { emit } = await import("@/platform/native/events");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const { ThemeProvider } = await import("@/components/ui/theme-provider");
    const { DocumentSurface } = await import("@/features/document/app-shell");
    return { emit, TooltipProvider, ThemeProvider, DocumentSurface };
  }

  async function render(
    props: {
      onClose?: () => void;
      onOpenFullPage?: () => void;
      /** The main area: the top bar elements go to its header. */
      main?: boolean;
      strict?: boolean;
    } = {},
  ) {
    const { emit, TooltipProvider, ThemeProvider, DocumentSurface } =
      await setup();
    const container = doc.getElementById("app")!;
    let root: Root;
    const surface = props.main ? (
      <DocumentSurface
        path="reports/report.html"
        projectPath="/project"
        spaceId={null}
        spacePath="/project"
        renderMainHeader={({ objectActions, viewTools }) => (
          <header data-main-header>
            <nav>reports / report.html</nav>
            {objectActions}
            {viewTools}
          </header>
        )}
      />
    ) : (
      <DocumentSurface
        path="reports/report.html"
        projectPath="/project"
        spaceId={null}
        spacePath="/project"
        onClose={props.onClose ?? (() => {})}
        onOpenFullPage={props.onOpenFullPage}
      />
    );
    const tree = (
      <ThemeProvider theme="light" setTheme={() => {}}>
        <TooltipProvider>{surface}</TooltipProvider>
      </ThemeProvider>
    );
    await act(async () => {
      root = createRoot(container);
      root.render(props.strict ? <StrictMode>{tree}</StrictMode> : tree);
    });
    await act(settle);
    return {
      emit,
      unmount: async () => {
        await act(async () => root.unmount());
        await act(settle);
      },
    };
  }

  const frame = () => doc.querySelector<HTMLIFrameElement>("iframe");
  const skeleton = () => doc.querySelector('[data-html-document="loading"]');
  const button = (name: string) =>
    [...doc.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.getAttribute("aria-label") === name ||
        candidate.textContent?.trim() === name,
    );
  const commands = (name: string) =>
    calls.filter((call) => call.command === name);

  async function loadFrame() {
    await act(async () => {
      frame()!.dispatchEvent(new dom.window.Event("load"));
    });
  }

  test("opens the live page by default and reloads it without a skeleton", async () => {
    reset();
    const view = await render();
    const page = frame()!;
    expect(page.getAttribute("src")).toBe(
      `http://127.0.0.1:${4000 + served}/report.html`,
    );
    expect(page.getAttribute("sandbox")).toBe(
      "allow-downloads allow-forms allow-modals allow-popups allow-same-origin allow-scripts",
    );
    expect(page.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(commands("html_document_serve")[0].args).toEqual({
      source: {
        kind: "space",
        projectPath: "/project",
        spaceId: null,
        targetPath: "reports/report.html",
      },
      theme: "light",
    });
    expect(skeleton() === null).toBe(false);
    await loadFrame();
    expect(skeleton()).toBeNull();
    expect(button("Preview")?.getAttribute("data-state")).toBe("on");

    // A file of the root changed: the page loads again, without a skeleton.
    const token = commands("html_document_serve").length;
    fixture.generation = "g2";
    await act(async () => {
      await view.emit("document:html-source-changed", {
        capabilityToken: `token-${served}`,
      });
    });
    await act(settle);
    expect(frame() !== page).toBe(true);
    expect(skeleton()).toBeNull();
    expect(commands("html_document_serve").length).toBe(token);

    // Another serving's change is not this page's.
    const current = frame();
    await act(async () => {
      await view.emit("document:html-source-changed", {
        capabilityToken: "token-other",
      });
    });
    await act(settle);
    expect(frame()).toBe(current);

    // Reload.
    await act(async () => button("Reload")!.click());
    expect(frame() !== current).toBe(true);
    expect(skeleton()).toBeNull();
    await view.unmount();
  });

  test("a theme change comes into the page and reloads it", async () => {
    reset();
    const view = await render();
    await loadFrame();
    const page = frame();
    await act(async () => {
      doc.documentElement.className = "dark";
    });
    await act(settle);
    expect(commands("html_document_set_theme").at(-1)?.args).toEqual({
      capabilityToken: `token-${served}`,
      theme: "dark",
    });
    expect(frame() !== page).toBe(true);
    expect(skeleton()).toBeNull();
    doc.documentElement.className = "light";
    await view.unmount();
  });

  test("revokes its serving when it closes", async () => {
    reset();
    const view = await render();
    const token = `token-${served}`;
    expect(commands("html_document_revoke").length).toBe(0);
    await view.unmount();
    expect(commands("html_document_revoke").map((call) => call.args)).toEqual([
      { capabilityToken: token },
    ]);
  });

  const servedTokens = () =>
    calls
      .filter((call) => call.command === "html_document_serve")
      .map((_, index, all) => `token-${served - all.length + index + 1}`);
  const revokedTokens = () =>
    commands("html_document_revoke").map((call) => call.args.capabilityToken);

  test("keeps one serving under StrictMode and none after it closes", async () => {
    reset();
    const view = await render({ strict: true });
    // StrictMode runs the effect twice: the first serving is revoked.
    expect(servedTokens().length).toBe(2);
    const open = servedTokens().filter(
      (token) => !revokedTokens().includes(token),
    );
    expect(open).toEqual([`token-${served}`]);
    expect(frame()!.getAttribute("src")).toBe(
      `http://127.0.0.1:${4000 + served}/report.html`,
    );
    await view.unmount();
    expect([...revokedTokens()].sort()).toEqual([...servedTokens()].sort());
  });

  test("revokes a serving that arrives after the surface closed", async () => {
    let release = () => {};
    reset({ serveGate: new Promise<void>((resolve) => (release = resolve)) });
    const view = await render();
    expect(commands("html_document_serve").length).toBe(1);
    await view.unmount();
    expect(revokedTokens()).toEqual([]);
    await act(async () => release());
    await act(settle);
    expect(revokedTokens()).toEqual([`token-${served}`]);
  });

  test("shows the source read-only and refuses one past its limit", async () => {
    reset();
    const view = await render();
    await loadFrame();
    await act(async () => button("Source")!.click());
    await act(settle);
    const source = doc.querySelector("[data-source-file]");
    expect(source?.getAttribute("data-source-file")).toBe(
      "reports/report.html",
    );
    expect(source?.textContent).toBe(SOURCE);
    // The page stays loaded out of sight and comes back as it was.
    const page = frame()!;
    expect(page.closest("[hidden]") === null).toBe(false);
    expect(button("Reload") === undefined).toBe(true);
    await act(async () => button("Preview")!.click());
    expect(frame()).toBe(page);
    expect(page.closest("[hidden]")).toBeNull();
    expect(skeleton()).toBeNull();
    expect(doc.querySelector("[data-source-file]")).toBeNull();
    await view.unmount();

    reset({ sizeBytes: 2_000_001 });
    const large = await render();
    await act(async () => button("Source")!.click());
    await act(settle);
    expect(
      doc.body.textContent?.includes("The source is too large to show"),
    ).toBe(true);
    expect(commands("document_read_source").length).toBe(0);
    await large.unmount();
  });

  test("names every refusal and keeps Open with", async () => {
    for (const [kind, text] of [
      ["symlink", "The file is a symbolic link."],
      ["path_unresolved", "The path can't be resolved"],
      ["source_inaccessible", "The file can't be read."],
      ["resource_limit", "The file is larger than 16 MiB."],
      ["unsupported_format", "The file isn't an HTML file."],
    ] as const) {
      reset({ serveFailure: { kind, message: kind } });
      const view = await render();
      expect(frame()).toBeNull();
      expect(doc.body.textContent?.includes("The page can't be shown")).toBe(
        true,
      );
      expect(doc.body.textContent?.includes(text)).toBe(true);
      expect(
        doc.querySelectorAll("[data-external-open-primary]").length >= 2,
      ).toBe(true);
      // Only a refusal by size still offers the source, within its own limit.
      expect(Boolean(button("Source"))).toBe(kind === "resource_limit");
      await view.unmount();
    }
  });

  test("a missing file, also one deleted while open, replaces the page", async () => {
    reset({ serveFailure: { kind: "source_missing", message: "missing" } });
    const missing = await render();
    expect(doc.body.textContent?.includes("File not found")).toBe(true);
    expect(doc.body.textContent?.includes("reports/report.html")).toBe(true);
    expect(frame()).toBeNull();
    await missing.unmount();

    reset();
    const view = await render();
    await loadFrame();
    fixture.inspectFailure = { kind: "source_missing", message: "missing" };
    await act(async () => {
      await view.emit("document:html-source-changed", {
        capabilityToken: `token-${served}`,
      });
    });
    await act(settle);
    expect(doc.body.textContent?.includes("File not found")).toBe(true);
    expect(frame()).toBeNull();
    // The file is back.
    fixture.inspectFailure = null;
    await act(async () => {
      await view.emit("document:html-source-changed", {
        capabilityToken: `token-${served}`,
      });
    });
    await act(settle);
    expect(frame() === null).toBe(false);
    await view.unmount();
  });

  test("the main area gets the tools in its header, without Expand", async () => {
    reset();
    const view = await render({ main: true });
    const header = doc.querySelector("[data-main-header]")!;
    expect(header.textContent?.includes("reports / report.html")).toBe(true);
    expect(header.querySelector('[aria-label="View"]') === null).toBe(false);
    expect(button("Expand") === undefined).toBe(true);
    expect(button("Close") === undefined).toBe(true);
    expect(frame() === null).toBe(false);
    await view.unmount();
  });

  test("Expand opens the document in the main area", async () => {
    reset();
    let expanded = 0;
    const view = await render({ onOpenFullPage: () => (expanded += 1) });
    await act(async () => button("Expand")!.click());
    expect(expanded).toBe(1);
    await view.unmount();
  });
}
