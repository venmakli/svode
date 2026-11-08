import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useContext, useEffect, useState } from "react";
import type {
  AttachmentActivationRequest,
  AttachmentItem,
} from "@/features/attachments";
import type { SpaceInfo } from "@/features/space";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { isEscapeTaken } from "@/shared/lib/escape-key";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_PEEK_ESCAPE_DOM !== "1") {
  test("one Esc closes the top peek with the terminal drawer and tooltips of the app", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_PEEK_ESCAPE_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = await createTestDom();
  const doc = dom.document;
  window.matchMedia = (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  const project = "/project";
  mockNativeIpc(
    (command) => {
      if (command === "document_inspect_source")
        return {
          format: "doc",
          sizeBytes: 12,
          generation: "g1",
          modifiedAt: "2026-01-02T03:04:05Z",
        };
      if (command === "media_create_source")
        throw { kind: "unsupported_format", message: "Not previewable" };
      if (
        command === "document_list_external_apps" ||
        command === "media_list_external_apps"
      )
        return [];
      if (command === "git_status")
        return {
          branch: "main",
          ahead: 0,
          behind: 0,
          hasStaged: false,
          hasUnstaged: false,
          hasConflicts: false,
          tracking: null,
          files: [],
        };
      if (command === "repository_access_get")
        return {
          status: "local",
          repositoryId: project,
          generation: 1,
          checkedAt: null,
          expiresAt: null,
          lastKnownStatus: null,
          reason: null,
        };
      if (command === "read_page" || command === "get_page_schema") return null;
      if (command.startsWith("plugin:event|")) return 1;
      throw new Error(`Unexpected IPC: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const m = await import("@/paraglide/messages.js");
  const { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } =
    await import("@/components/ui/tooltip");
  const { AttachmentsPeek } = await import("@/features/attachments");
  const { PagePeekSheet } = await import("@/features/collection/app-shell");
  const { TerminalPanelHost } = await import("@/features/terminal");
  const { PeekIdentity, PeekTopBar } = await import("@/shared/ui/peek-top-bar");
  const { TitleZone } = await import("@/features/page/detail");
  const { CollectionPropertyPanel } =
    await import("@/features/properties/panel");
  const { defineOwnerDefinedCollectionProperty } =
    await import("@/features/properties");
  const { UserEditScope } = await import("@/features/navigation");
  const { ThemeProvider } = await import("@/components/ui/theme-provider");
  const { ChatAttachmentOpenerContext } =
    await import("@/features/agent-sessions");
  const { registerRootSpace } = await import("@/features/space");

  interface Note {
    summary: string | null;
  }
  const summary = defineOwnerDefinedCollectionProperty<Note>({
    capabilities: {
      edit: { getState: () => ({ status: "idle" }), update: async () => {} },
    },
    featureId: "test",
    getValue: (note) => note.summary,
    key: "summary",
    label: "Summary",
    standard: { type: "text" },
  });
  /**
   * The content of a page peek as the owner peek draws it: the top bar, the
   * editable title of the page and its properties.
   */
  function PageContent({ onClose }: { onClose(): void }) {
    return (
      <ThemeProvider theme="light" setTheme={() => {}}>
        <UserEditScope mainArea={false}>
          <PeekTopBar
            identity={<PeekIdentity icon={null} name="Roadmap" />}
            onExpand={() => {}}
            onClose={onClose}
          />
          <TitleZone
            title="Roadmap"
            icon={null}
            description=""
            hideDescription
            onTitleChange={() => {}}
            onIconChange={() => {}}
            onDescriptionChange={() => {}}
            onBodyFocus={() => {}}
          />
          <CollectionPropertyPanel
            item={{ summary: "Review" }}
            properties={[summary]}
          />
        </UserEditScope>
      </ThemeProvider>
    );
  }
  // The chat opens a page in the owner peek of the app shell.
  mock.module("./compact-scope-peek", () => ({
    CompactScopePeek: ({ onClose }: { onClose(): void }) => (
      <PageContent onClose={onClose} />
    ),
  }));
  const { ChatAttachmentPeekProvider } = await import("./chat-attachment-peek");

  async function settle() {
    await act(async () => {
      for (let index = 0; index < 10; index += 1)
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  /** Moves the keyboard focus, as Tab or autofocus does: its tooltip opens. */
  async function focus(element: HTMLElement) {
    await act(async () => element.focus());
    await settle();
  }
  /** One Esc on the focused element, a real keydown through every layer. */
  async function pressEscape() {
    const target = (doc.activeElement as HTMLElement | null) ?? doc.body;
    const event = new window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
    return event;
  }
  const sheets = () => [
    ...doc.querySelectorAll<HTMLElement>('[data-slot="sheet-content"]'),
  ];
  const peeks = () =>
    sheets().filter((sheet) => !sheet.hasAttribute("data-terminal-drawer"));
  const drawer = () =>
    sheets().find((sheet) => sheet.hasAttribute("data-terminal-drawer"));
  const tooltip = () =>
    doc.querySelector<HTMLElement>('[data-slot="tooltip-content"]');
  const byLabel = (label: string) =>
    peeks().at(-1)?.querySelector<HTMLElement>(`[aria-label="${label}"]`) ??
    null;
  const row = () => doc.querySelector<HTMLElement>("[data-row]")!;
  const titleField = () =>
    peeks().at(-1)!.querySelector<HTMLInputElement>("[data-page-title-input]")!;
  const propertyField = () =>
    peeks()
      .at(-1)!
      .querySelector<HTMLInputElement>(
        '[data-collection-property-editor="summary"] input',
      )!;

  /** Types into a field as a user does, the field focused. */
  async function type(field: HTMLInputElement, value: string) {
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set!.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await settle();
  }
  /**
   * Esc in an edit of the title or a property of the top peek cancels the
   * edit and keeps the peek; the next Esc closes it, focus at `source`.
   */
  async function expectTwoStepEscape(
    field: () => HTMLInputElement,
    saved: string,
    source: () => HTMLElement,
  ) {
    await type(field(), "Draft");
    expect(field().value).toBe("Draft");
    await pressEscape();
    expect(peeks().length).toBe(1);
    expect(field().value).toBe(saved);
    expect(doc.activeElement === field()).toBe(false);
    await pressEscape();
    expect(peeks().length).toBe(0);
    await settle();
    expect(doc.activeElement).toBe(source());
  }

  function attachment(kind: AttachmentItem["kind"], path: string) {
    const item: AttachmentItem = {
      key: `${kind}:${path}`,
      path,
      contentPath: null,
      ownerPath: ".",
      sourcePath: path,
      sourceShape: "file",
      kind,
      hasApp: false,
      icon: null,
      displayName: path.split("/").at(-1)!,
      modified: "",
      sizeBytes: null,
      format: "",
      availability: "available",
    };
    return item;
  }

  let setRequest: (
    request: AttachmentActivationRequest | null,
  ) => void = () => {};
  const openAttachment = (item: AttachmentItem) =>
    setRequest({
      item,
      owner: {
        projectPath: project,
        spacePath: project,
        spaceId: null,
        ownerPath: ".",
        repositoryPath: project,
      },
      mode: "peek",
      sourceGeneration: "one",
      activation: {
        itemId: item.key,
        returnFocus: () => doc.querySelector<HTMLElement>("[data-row]"),
      },
    });
  /** A row of Attachments and the peek it opens, as the owner screen has. */
  function Attachments() {
    const [request, setShownRequest] =
      useState<AttachmentActivationRequest | null>(null);
    useEffect(() => {
      setRequest = setShownRequest;
    }, []);
    return (
      <>
        <button type="button" data-row>
          row
        </button>
        <AttachmentsPeek
          owner={{
            ownerKey: "space:root",
            identityKind: "registered-space",
            projectPath: project,
            spacePath: project,
            spaceId: "root",
            ownerPath: ".",
            contentPath: "README.md",
            hasDirectCollection: false,
          }}
          readOnly={false}
          target={request}
          onOpenChange={(open) => {
            if (!open) setShownRequest(null);
          }}
          renderOwnerPeek={(context) => (
            <PageContent onClose={context.onClose} />
          )}
        />
      </>
    );
  }

  /** The window: the main area with its terminal drawer, mounted closed. */
  async function mountApp() {
    await dom.render(
      <TooltipProvider delayDuration={300}>
        <Attachments />
        <TerminalPanelHost />
      </TooltipProvider>,
    );
    await settle();
  }
  async function open(item: AttachmentItem) {
    await act(async () => openAttachment(item));
    await settle();
    expect(peeks().length).toBe(1);
  }
  async function expectClosedToRow() {
    expect(peeks().length).toBe(0);
    expect(tooltip()).toBeNull();
    // The drawer stays as it was.
    expect(drawer()?.getAttribute("data-state")).toBe("closed");
    await settle();
    expect(doc.activeElement).toBe(row());
  }

  test("a document peek of Attachments closes on one Esc after opening, after Tab and with a hover tooltip", async () => {
    await mountApp();
    const report = attachment("document", "report.doc");

    // The first opening, before the viewer loads: the sheet has the focus.
    await open(report);
    await pressEscape();
    await expectClosedToRow();

    // The viewer is loaded: autofocus lands on the first button of the top
    // bar and shows its tooltip.
    await import("@/features/document/app-shell");
    await open(report);
    expect(doc.activeElement?.getAttribute("data-slot")).toBe(
      "tooltip-trigger",
    );
    expect(Boolean(tooltip())).toBe(true);
    await pressEscape();
    await expectClosedToRow();

    // Tab to Close shows its tooltip.
    await open(report);
    await focus(byLabel(m.peek_close())!);
    expect(tooltip()?.textContent?.includes(m.peek_close())).toBe(true);
    await pressEscape();
    await expectClosedToRow();

    // A click on the name of the file leaves the focus on the sheet, while
    // the pointer rests on a button and shows its tooltip.
    await open(report);
    await focus(peeks()[0]!);
    const expand = byLabel(m.peek_expand())!;
    await act(async () => {
      expand.dispatchEvent(
        new window.MouseEvent("pointermove", { bubbles: true }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    expect(tooltip()?.textContent?.includes(m.peek_expand())).toBe(true);
    expect(doc.activeElement).toBe(peeks()[0]!);
    await pressEscape();
    await expectClosedToRow();
    await dom.render(null);
  }, 30_000);

  test("a popover over the peek closes on Esc and the peek stays", async () => {
    await mountApp();
    await open(attachment("document", "report.doc"));
    const details = byLabel(m.document_details())!;
    await act(async () => details.click());
    await settle();
    expect(Boolean(doc.querySelector('[data-slot="popover-content"]'))).toBe(
      true,
    );
    await pressEscape();
    expect(doc.querySelector('[data-slot="popover-content"]')).toBeNull();
    expect(peeks().length).toBe(1);
    // The next Esc, now from the ⓘ button with its tooltip, closes the peek.
    await focus(byLabel(m.document_details())!);
    expect(Boolean(tooltip())).toBe(true);
    await pressEscape();
    await expectClosedToRow();
    await dom.render(null);
  }, 30_000);

  test("a media peek of Attachments closes on one Esc after Tab to its top bar", async () => {
    await mountApp();
    await import("@/features/media/app-shell");
    const shot = attachment("media", "photos/shot.heic");
    await open(shot);
    await pressEscape();
    await expectClosedToRow();

    await open(shot);
    await focus(byLabel(m.peek_close())!);
    expect(Boolean(tooltip())).toBe(true);
    await pressEscape();
    await expectClosedToRow();
    await dom.render(null);
  }, 30_000);

  test("a page peek closes on one Esc from its top bar; Esc in its title or a property first cancels the edit", async () => {
    const page = {
      path: "Tasks/Roadmap.md",
      body: "",
      meta: {
        title: "Roadmap",
        icon: null,
        created: "",
        updated: "",
        extra: {},
      },
    };
    let setOpen: (open: boolean) => void = () => {};
    function PagePeek() {
      const [opened, setOpened] = useState(false);
      useEffect(() => {
        setOpen = setOpened;
      }, []);
      return (
        <PagePeekSheet
          target={opened ? { page, nested: false } : null}
          readOnly={false}
          spacePath={project}
          spaceId="root"
          projectPath={project}
          onOpenChange={setOpened}
          onOpenPath={() => {}}
          onDuplicatePage={() => {}}
          onDeletePage={() => {}}
          onConvertedPage={() => {}}
          renderPeek={(context) => (
            <PageContent onClose={() => context.dismiss()} />
          )}
        />
      );
    }
    await dom.render(
      <TooltipProvider delayDuration={300}>
        <button type="button" data-row>
          row
        </button>
        <PagePeek />
        <TerminalPanelHost />
      </TooltipProvider>,
    );
    await settle();
    await focus(row());
    await act(async () => setOpen(true));
    await settle();

    // Esc returns the focus where the close button does.
    await act(async () => byLabel(m.peek_close())!.click());
    await settle();
    const focusAfterButton = doc.activeElement;
    await focus(row());
    await act(async () => setOpen(true));
    await settle();
    await focus(byLabel(m.peek_expand())!);
    expect(Boolean(tooltip())).toBe(true);
    await pressEscape();
    expect(peeks().length).toBe(0);
    expect(tooltip()).toBeNull();
    await settle();
    expect(doc.activeElement).toBe(focusAfterButton);

    for (const field of [titleField, propertyField]) {
      await act(async () => setOpen(true));
      await settle();
      await expectTwoStepEscape(
        field,
        field === titleField ? "Roadmap" : "Review",
        () => focusAfterButton as HTMLElement,
      );
    }
    await dom.render(null);
  }, 30_000);

  test("a page peek of Attachments: one Esc closes it, Esc in its title or a property first cancels the edit", async () => {
    await mountApp();
    const page = attachment("page", "Roadmap.md");
    await open(page);
    await pressEscape();
    await expectClosedToRow();

    await open(page);
    await expectTwoStepEscape(titleField, "Roadmap", row);
    await open(page);
    await expectTwoStepEscape(propertyField, "Review", row);
    await dom.render(null);
  }, 30_000);

  test("a page peek of the chat: one Esc closes it, Esc in its title or a property first cancels the edit", async () => {
    registerRootSpace({
      id: "root",
      name: "Project",
      path: project,
    } as SpaceInfo);
    let openChatAttachment: (attachment: {
      path: string;
      name: string;
    }) => void = () => {};
    function Badge() {
      const opener = useContext(ChatAttachmentOpenerContext);
      useEffect(() => {
        if (opener) openChatAttachment = opener;
      });
      return (
        <button type="button" data-badge>
          Roadmap.md
        </button>
      );
    }
    await dom.render(
      <TooltipProvider delayDuration={300}>
        <ChatAttachmentPeekProvider>
          <Badge />
        </ChatAttachmentPeekProvider>
        <TerminalPanelHost />
      </TooltipProvider>,
    );
    await settle();
    const badge = () => doc.querySelector<HTMLElement>("[data-badge]")!;
    async function openFromChat() {
      await focus(badge());
      await act(async () =>
        openChatAttachment({
          path: `${project}/Roadmap.md`,
          name: "Roadmap.md",
        }),
      );
      await settle();
      expect(peeks().length).toBe(1);
    }

    await openFromChat();
    await pressEscape();
    expect(peeks().length).toBe(0);
    await settle();
    expect(doc.activeElement).toBe(badge());

    await openFromChat();
    await expectTwoStepEscape(titleField, "Roadmap", badge);
    await openFromChat();
    await expectTwoStepEscape(propertyField, "Review", badge);
    await dom.render(null);
  }, 30_000);

  test("without a peek a tooltip in the main area does not take Esc from it", async () => {
    const seen: boolean[] = [];
    await dom.render(
      <TooltipProvider delayDuration={300}>
        <div
          data-main
          onKeyDown={(event) => {
            if (event.key === "Escape")
              seen.push(isEscapeTaken(event.nativeEvent));
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label="Stop">
                stop
              </button>
            </TooltipTrigger>
            <TooltipContent>Stop</TooltipContent>
          </Tooltip>
        </div>
        <TerminalPanelHost />
      </TooltipProvider>,
    );
    await settle();
    await focus(doc.querySelector<HTMLElement>('[aria-label="Stop"]')!);
    expect(Boolean(tooltip())).toBe(true);
    await pressEscape();
    expect(tooltip()).toBeNull();
    // The key reaches the main area as an Esc nobody took, e.g. to stop a
    // turn; the drawer keeps itself as it was.
    expect(seen).toEqual([false]);
    expect(drawer()?.getAttribute("data-state")).toBe("closed");
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  }, 30_000);
}
