import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";

if (process.env.SVODE_AGENT_ACTOR_SCREEN_DOM !== "1") {
  test("Agent screen DOM", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AGENT_ACTOR_SCREEN_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 60_000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='app'></div></body></html>",
    { url: "http://localhost/", pretendToBeVisual: true },
  );
  installDomGlobals(dom);
  const { createRoot } = await import("react-dom/client");

  const REVIEWER = "01arz3ndektsv4rrffq69g5fav";
  const CREATED = "01arz3ndektsv4rrffq69g5fax";
  interface ActorRead {
    actor: {
      binding: unknown;
      description: string | null;
      id: string;
      name: string;
    };
    mode: null;
    ownerPath: string;
    version: string;
  }
  let actors: ActorRead[] = [];
  let diagnostics: {
    ownerPath: string;
    code: string;
    reason?: string;
    message: string;
  }[] = [];
  let fingerprints: Record<string, string> = {};
  const writes: Record<string, unknown>[] = [];

  const { mockNativeIpc } = await import("@/platform/native/testing");
  mockNativeIpc(
    (command, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      switch (command) {
        case "agent_actors_get":
          return {
            bindableAgents: [{ displayName: "Codex", id: "codex" }],
            ownerFingerprints: fingerprints,
            resolution: { actors, diagnostics },
          };
        case "agent_actors_generate_id":
          return CREATED;
        case "agent_actors_mutate": {
          writes.push(payload);
          const mutation = payload.mutation as {
            kind: string;
            actor: ActorRead["actor"];
          };
          if (mutation.kind === "create") {
            actors = [
              ...actors,
              {
                actor: mutation.actor,
                mode: null,
                ownerPath: payload.ownerPath as string,
                version: "c1",
              },
            ];
          }
          return {
            status: "applied",
            version: "v2",
            persistence: { status: "committed" },
            rootPointer: null,
          };
        }
        case "actors_get_catalog":
          return {
            diagnostics: [],
            generation: 1,
            repositoryId: "actor-repo-test",
            rows: [],
            shallow: false,
          };
        case "repository_access_get":
          return {
            checkedAt: Date.now(),
            expiresAt: null,
            generation: 1,
            lastKnownStatus: "local",
            reason: null,
            repositoryId: "repo-test",
            status: "local",
          };
        case "agent_adapters_list_identities":
          return [{ id: "codex", displayName: "Codex" }];
        case "agent_default_get":
          return null;
        case "agent_setup_chat_agents":
          return {
            agents: [
              { agent: "codex", name: "Codex", offer: { state: "available" } },
            ],
          };
        case "agent_runtime_last_declarations":
          return [];
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );

  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  setLocale("en", { reload: false });
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { createRegisteredSpaceOwner } =
    await import("@/features/scope-surfaces");
  const { ActorsSurface } = await import("./actors-surface");

  const owner = createRegisteredSpaceOwner({
    hasSchema: false,
    projectPath: "/project",
    spaceId: "root",
    spacePath: "/repo",
    status: "ready",
  });
  const mounted: Root[] = [];

  function screenTest(name: string, fn: () => Promise<void>) {
    test(name, async () => {
      actors = [reviewer()];
      diagnostics = [];
      fingerprints = { "/repo": "catalog", "/project": "root" };
      writes.length = 0;
      try {
        await fn();
      } finally {
        for (const root of mounted.splice(0)) {
          await act(async () => root.unmount());
        }
        document.body.innerHTML = "<div id='app'></div>";
      }
    });
  }

  screenTest(
    "the name and the description are saved at once from the header; an empty name is not written",
    async () => {
      await mount(REVIEWER);
      expect(title()?.value).toBe("Reviewer");
      expect(peekText().includes("Owner")).toBe(false);

      await edit(title()!, "   ");
      await blur(title()!);
      expect(writes).toEqual([]);
      expect(title()?.value).toBe("Reviewer");
      expect(peekText().includes(m.object_header_title_required())).toBe(true);

      await edit(title()!, "Critic");
      await key(title()!, "Enter");
      expect(writes).toEqual([
        {
          expectedVersion: "v1",
          mutation: {
            kind: "update",
            actor: {
              binding: { agent: "codex", settings: [] },
              description: "Reviews changes",
              id: REVIEWER,
              name: "Critic",
            },
            mode: null,
          },
          ownerPath: "/repo",
          projectPath: "/project",
        },
      ]);

      // An empty description is allowed.
      await focus(description()!);
      await edit(description()!, "");
      await blur(description()!);
      expect(
        (writes[1]?.mutation as { actor: { description: unknown } }).actor
          .description,
      ).toBe(null);
      expect(writes[1]?.expectedVersion).toBe("v2");
    },
  );

  screenTest(
    "creating an Agent writes New agent 2 bound to the participant's agent and opens it with focus in its name",
    async () => {
      actors = [
        reviewer(),
        {
          ...reviewer(),
          actor: {
            ...reviewer().actor,
            id: "01arz3ndektsv4rrffq69g5faw",
            name: "New agent",
          },
          version: "w1",
        },
      ];
      await mount(REVIEWER);
      await act(async () => {
        document
          .querySelector<HTMLButtonElement>('[aria-label="Close"]')!
          .click();
      });
      await settle();
      const create = document.querySelector<HTMLButtonElement>(
        '[data-collection-create="add-agent"]',
      );
      expect(create === null).toBe(false);
      await act(async () => create!.click());
      await settle();
      expect(writes).toEqual([
        {
          expectedVersion: null,
          mutation: {
            kind: "create",
            actor: {
              binding: { participant: true },
              description: null,
              id: CREATED,
              name: "New agent 2",
            },
            mode: null,
          },
          ownerPath: "/repo",
          projectPath: "/project",
        },
      ]);
      expect(title()?.value).toBe("New agent 2");
      expect(document.activeElement).toBe(title());
    },
  );

  screenTest(
    "an unreadable catalog shows the text of its cause, never its raw message, and the inherited one as the project's",
    async () => {
      actors = [{ ...reviewer(), ownerPath: "/project" }];
      fingerprints = {};
      diagnostics = [
        {
          code: "catalog_unavailable",
          message:
            "Agent catalog schema version 9 is newer than this version of Svode supports (2)",
          ownerPath: "/repo",
          reason: "newer_format",
        },
        {
          code: "catalog_unavailable",
          message: "Invalid agent catalog: expected value at line 1 column 3",
          ownerPath: "/project",
          reason: "damaged",
        },
      ];
      await mount("");
      const banner =
        document.querySelector("[data-collection-diagnostics]")?.textContent ??
        "";
      expect(banner.includes(m.agent_actors_catalog_newer_format())).toBe(true);
      expect(banner.includes(m.agent_actors_catalog_damaged_project())).toBe(
        true,
      );
      expect(banner.includes("schema version 9")).toBe(false);
      expect(banner.includes("Invalid agent catalog")).toBe(false);
      // The agents of the readable root stay; adding one to the Space does not.
      expect(document.body.textContent?.includes("Reviewer")).toBe(true);
      expect(
        document.querySelector<HTMLButtonElement>(
          '[data-collection-create="add-agent"]',
        )?.disabled,
      ).toBe(true);
    },
  );

  function reviewer(): ActorRead {
    return {
      actor: {
        binding: { agent: "codex", settings: [] },
        description: "Reviews changes",
        id: REVIEWER,
        name: "Reviewer",
      },
      mode: null,
      ownerPath: "/repo",
      version: "v1",
    };
  }

  async function mount(open: string) {
    const root = createRoot(document.getElementById("app")!);
    mounted.push(root);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ActorsSurface
            owner={owner}
            openItem={{ consume: () => undefined, id: open }}
            presentation="full"
            onOpenAgentSettings={() => undefined}
          />
        </TooltipProvider>,
      );
    });
    await settle();
  }

  function title() {
    return document.querySelector<HTMLInputElement>(
      "[data-object-content-header-title]",
    );
  }

  function description() {
    return document.querySelector<HTMLTextAreaElement>(
      "[data-object-content-header-description]",
    );
  }

  function peekText() {
    return (
      document.querySelector("[data-collection-item-peek]")?.textContent ?? ""
    );
  }

  async function focus(element: HTMLElement) {
    await act(async () => element.focus());
  }

  async function edit(
    element: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ) {
    await act(async () => {
      element.focus();
      const setter = Object.getOwnPropertyDescriptor(
        Object.getPrototypeOf(element),
        "value",
      )!.set!;
      setter.call(element, value);
      element.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
  }

  async function blur(element: HTMLElement) {
    await act(async () => element.blur());
    await settle();
  }

  async function key(element: HTMLElement, name: string) {
    await act(async () => {
      element.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: name, bubbles: true }),
      );
    });
    await settle();
  }

  async function settle() {
    for (let index = 0; index < 12; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    CSS: dom.window.CSS ?? { escape: (value: string) => value },
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
    Document: dom.window.Document,
    DocumentFragment: dom.window.DocumentFragment,
    Element: dom.window.Element,
    Event: dom.window.Event,
    FocusEvent: dom.window.FocusEvent,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    KeyboardEvent: dom.window.KeyboardEvent,
    MouseEvent: dom.window.MouseEvent,
    MutationObserver: dom.window.MutationObserver,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    PointerEvent: dom.window.MouseEvent,
    ShadowRoot: dom.window.ShadowRoot,
    SVGElement: dom.window.SVGElement,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    matchMedia: () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }),
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  dom.window.matchMedia = values.matchMedia as typeof window.matchMedia;
}
