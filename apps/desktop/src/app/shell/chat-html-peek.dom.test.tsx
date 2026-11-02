import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect, useState } from "react";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_CHAT_HTML_PEEK_DOM !== "1") {
  test("chat HTML opens in the HTML Document peek", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_CHAT_HTML_PEEK_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const dom = await createTestDom();
  const doc = dom.document;
  window.HTMLElement.prototype.scrollTo = () => {};
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const APP_FILES = "/project/tools/dash/";
  let served = 0;
  const descriptor = {
    format: "html",
    sizeBytes: 12,
    generation: "g1",
    modifiedAt: "2026-11-02T10:00:00Z",
  };
  mockNativeIpc(
    (command, raw) => {
      const args = (raw ?? {}) as Record<string, unknown>;
      calls.push({ command, args });
      switch (command) {
        case "html_document_app_directory":
          return String(args.targetPath).startsWith("tools/dash/")
            ? "tools/dash"
            : null;
        case "html_document_serve":
          served += 1;
          return {
            capabilityToken: `token-${served}`,
            viewportUrl: `http://127.0.0.1:${4000 + served}/report.html`,
            sizeBytes: 12,
            modifiedAt: descriptor.modifiedAt,
          };
        case "document_inspect_source":
        case "html_document_local_inspect":
          return descriptor;
        case "document_list_external_apps":
        case "html_document_local_list_external_apps":
        case "list_project_openers":
          return [];
        default:
          // The App owner peek and the Changes control read more of the
          // project; only what this test names matters.
          return null;
      }
    },
    { shouldMockEvents: true },
  );
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;

  const m = await import("@/paraglide/messages.js");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { Sheet, SheetContent, SheetTitle } =
    await import("@/components/ui/sheet");
  const { ChatAttachmentOpenerContext } =
    await import("@/features/agent-sessions");
  const spaces = {
    rootSpaces: [{ id: "root", name: "Project", path: "/project" }],
    spaces: [],
    fileTrees: {},
    activeRootId: "root",
    activeRootName: "Project",
    activeRootPath: "/project",
  };
  const realSpace = await import("@/features/space");
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector?: (state: typeof spaces) => unknown) =>
      selector ? selector(spaces) : spaces,
  }));
  const { usePeekStackEntry } =
    await import("@/shared/hooks/use-peek-stack-entry");
  const { closeTopPeek } = await import("@/shared/lib/peek-stack");
  const { ChatAttachmentPeekProvider } = await import("./chat-attachment-peek");

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 10; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  const commands = (name: string) =>
    calls.filter((call) => call.command === name).map((call) => call.args);
  const htmlPeek = () =>
    [...doc.querySelectorAll('[data-slot="sheet-content"]')].find((sheet) =>
      sheet.querySelector("iframe"),
    );
  const labelled = (sheet: Element | undefined, label: string) =>
    sheet?.querySelector(`[aria-label="${label}"]`) ?? null;

  let open: ((attachment: { path: string; name: string }) => void) | null =
    null;
  function Opener() {
    const opener = useContext(ChatAttachmentOpenerContext);
    useEffect(() => {
      open = opener;
    });
    return null;
  }
  async function openAttachment(path: string) {
    await act(async () =>
      open!({ path, name: path.split("/").at(-1) ?? path }),
    );
    await settle();
  }

  function SessionPeek() {
    const [opened, setOpened] = useState(true);
    usePeekStackEntry(opened, () => setOpened(false));
    return (
      <Sheet open={opened} onOpenChange={setOpened}>
        <SheetContent data-session-peek>
          <SheetTitle>Session</SheetTitle>
          <Opener />
        </SheetContent>
      </Sheet>
    );
  }

  async function render(children: React.ReactNode) {
    await dom.render(
      <ThemeProvider theme="light" setTheme={() => {}}>
        <TooltipProvider>
          <ChatAttachmentPeekProvider>{children}</ChatAttachmentPeekProvider>
        </TooltipProvider>
      </ThemeProvider>,
    );
    await settle();
  }

  test("HTML of the project opens the HTML Document peek with Changes and Expand", async () => {
    await render(<Opener />);
    calls.length = 0;
    await openAttachment("/project/reports/report.html");
    expect(commands("html_document_app_directory")).toEqual([
      {
        projectPath: "/project",
        spaceId: null,
        targetPath: "reports/report.html",
      },
    ]);
    expect(commands("html_document_serve")).toEqual([
      {
        source: {
          kind: "space",
          projectPath: "/project",
          spaceId: null,
          targetPath: "reports/report.html",
        },
        theme: "light",
      },
    ]);
    const peek = htmlPeek();
    expect(peek?.querySelector("[data-peek-identity]")?.textContent).toBe(
      "report.html",
    );
    expect(labelled(peek, m.peek_expand()) === null).toBe(false);
    expect(commands("plugin:shell|open")).toEqual([]);
    await act(async () => {
      closeTopPeek();
    });
    await settle();
    expect(htmlPeek()).toBe(undefined);
    expect(commands("html_document_revoke")).toEqual([
      { capabilityToken: `token-${served}` },
    ]);
    await dom.render(null);
  });

  test("HTML outside the project opens only to view it, without Changes and Expand", async () => {
    await render(<Opener />);
    calls.length = 0;
    const path = "/private/tmp/claude/scratchpad/dash.HTM";
    await openAttachment(path);
    expect(commands("html_document_app_directory")).toEqual([]);
    expect(commands("html_document_serve")).toEqual([
      { source: { kind: "local", path }, theme: "light" },
    ]);
    expect(commands("html_document_local_inspect")).toEqual([{ path }]);
    const peek = htmlPeek();
    expect(peek?.querySelector("[data-peek-identity]")?.textContent).toBe(
      "dash.HTM",
    );
    expect(labelled(peek, m.peek_expand())).toBeNull();
    expect(peek?.querySelector("[data-changes-trigger]") ?? null).toBeNull();
    expect(commands("plugin:shell|open")).toEqual([]);
    await act(async () => {
      closeTopPeek();
    });
    await settle();
    await dom.render(null);
  });

  test("HTML of an App opens the App, not a Document; a PDF outside opens in its app", async () => {
    await render(<Opener />);
    calls.length = 0;
    await openAttachment(`${APP_FILES}public/index.html`);
    expect(commands("html_document_app_directory")).toEqual([
      {
        projectPath: "/project",
        spaceId: null,
        targetPath: "tools/dash/public/index.html",
      },
    ]);
    expect(commands("html_document_serve")).toEqual([]);
    expect(htmlPeek()).toBe(undefined);
    expect(commands("plugin:shell|open")).toEqual([]);
    await act(async () => {
      closeTopPeek();
    });
    await settle();

    calls.length = 0;
    await openAttachment("/Users/me/guide.pdf");
    expect(commands("plugin:shell|open").length).toBe(1);
    expect(commands("html_document_serve")).toEqual([]);
    await dom.render(null);
  });

  test("from the session peek the HTML peek is its child: closing it keeps the session", async () => {
    await render(<SessionPeek />);
    await openAttachment("/project/reports/report.html");
    expect(htmlPeek() === undefined).toBe(false);
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);
    await act(async () => {
      closeTopPeek();
    });
    await settle();
    expect(htmlPeek()).toBe(undefined);
    expect(Boolean(doc.querySelector("[data-session-peek]"))).toBe(true);
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  });
}
