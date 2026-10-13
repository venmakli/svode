import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";

if (process.env.SVODE_GENERAL_ACCESS_DOM !== "1") {
  test("general details recover a write refused by repository access", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GENERAL_ACCESS_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 20000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const mock = (
    bunTest as typeof bunTest & {
      mock: { module(name: string, factory: () => unknown): void };
    }
  ).mock;
  const realSpace = await import("@/features/space");
  const spaces = [
    { id: "docs", name: "Docs", path: "/project/docs" },
    { id: "notes", name: "Notes", path: "/project/notes" },
  ].map((space) => ({
    ...space,
    icon: "",
    description: "",
    hasSpaces: false,
    hasSchema: false,
    lastOpened: null,
    status: "ready" as const,
    lfsState: "n/a" as const,
  }));
  const patches: [string, unknown][] = [];
  const spaceState = {
    activeRootPath: "/project",
    activeRootId: "project",
    activeRootName: "Project",
    spaces,
    patchSpaceMetadata: (path: string, updates: unknown) =>
      patches.push([path, updates]),
  };
  mock.module("@/features/space", () => ({
    ...realSpace,
    useSpace: (selector?: (state: unknown) => unknown) =>
      selector ? selector(spaceState) : spaceState,
    CreateSpaceDialog: () => null,
  }));
  // The next icon the picker selects.
  let pickedIcon = "";
  mock.module("@/components/ui/emoji-picker", () => ({
    EmojiPicker: ({
      value,
      onChange,
    }: {
      value: string;
      onChange: (icon: string) => void;
    }) => (
      <button
        type="button"
        data-emoji-picker={value}
        onClick={() => onChange(pickedIcon)}
      >
        {value}
      </button>
    ),
  }));
  mock.module("../hooks/use-space-settings-health", () => ({
    useSpaceSettingsHealth: () => ({
      brokenLinksCount: 0,
      linkHealthLoading: false,
      linkHealthFailed: false,
      loadLinkHealth: () => {},
    }),
  }));

  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const { toast } = await import("sonner");
  const m = await import("@/paraglide/messages.js");
  const { setLocale } = await import("@/paraglide/runtime");
  const { ProjectGeneralSection } = await import("./project-general-section");
  const { createRoot } = await import("react-dom/client");

  const repositoryOf: Record<string, string> = {
    "/project": "repo-project",
    "/project/docs": "repo-docs",
    "/project/notes": "repo-notes",
  };
  const access: Record<string, "unknown" | "writable" | "local"> = {
    "repo-project": "unknown",
    "repo-docs": "unknown",
    "repo-notes": "local",
  };
  const configs: Record<string, Record<string, unknown>> = {
    "/project": { name: "Project", description: "", icon: "📁" },
    "/project/docs": { name: "Docs", description: "", icon: "📘" },
    "/project/notes": { name: "Notes", description: "", icon: "📝" },
  };
  const commands: string[] = [];
  const saves: { spacePath: string; configData: Record<string, unknown> }[] =
    [];
  // Owners whose access lapses before their next save.
  const refuseNext = new Set<string>();
  // Owners whose next save fails for a reason other than access.
  const failNext = new Set<string>();
  const toasts: unknown[] = [];
  toast.error = ((message: unknown) => {
    toasts.push(message);
    return 0;
  }) as typeof toast.error;

  const snapshot = (repositoryId: string) => ({
    repositoryId,
    generation: 1,
    status: access[repositoryId],
    ...(access[repositoryId] === "unknown" ? { reason: "not_checked" } : {}),
  });
  const denial = (spacePath: string) => {
    const repositoryId = repositoryOf[spacePath];
    return {
      kind: "repository_access_denied",
      repositoryId,
      status: "unknown",
      reason: "not_checked",
      blockers: [
        {
          repositoryId,
          repositoryPath: spacePath,
          status: "unknown",
          reason: "not_checked",
        },
      ],
    };
  };
  mockNativeIpc(
    (command, args) => {
      commands.push(command);
      const { spacePath } = args as { spacePath: string };
      if (command === "get_space_config") return { ...configs[spacePath] };
      if (command === "repository_access_get")
        return snapshot(repositoryOf[spacePath]);
      if (command === "repository_access_verify") {
        access[repositoryOf[spacePath]] = "writable";
        return snapshot(repositoryOf[spacePath]);
      }
      if (command === "save_space_config") {
        const save = args as (typeof saves)[number];
        if (failNext.delete(spacePath)) throw new Error("Synthetic failure");
        // A refused save finds the access lapsed again.
        if (refuseNext.delete(spacePath))
          access[repositoryOf[spacePath]] = "unknown";
        if (access[repositoryOf[spacePath]] === "unknown")
          throw denial(spacePath);
        saves.push(save);
        configs[spacePath] = save.configData;
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );

  const doc = dom.window.document;
  const settle = () =>
    act(async () => {
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const block = (name: string) =>
    Array.from(doc.querySelectorAll("section")).find(
      (section) =>
        section.querySelector(":scope > h3") &&
        doc.getElementById(section.getAttribute("aria-labelledby") ?? "")
          ?.textContent === name,
    )!;
  const nameInput = (owner: string) =>
    block(owner).querySelector<HTMLInputElement>('input[id$="-name"]')!;
  const descriptionInput = (owner: string) =>
    block(owner).querySelector<HTMLTextAreaElement>("textarea")!;
  const picker = (owner: string) =>
    block(owner).querySelector<HTMLButtonElement>("[data-emoji-picker]")!;
  const recovery = (owner: string) =>
    block(owner).querySelector("[data-repository-access-inline-recovery]");
  const button = (owner: string, label: string) =>
    Array.from(block(owner).querySelectorAll("button")).find(
      (node) => node.textContent === label,
    );
  const retryLabel = () =>
    m.git_access_preflight_retry({ action: m.settings_general_save_changes() });
  const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
    act(async () => {
      const prototype = Object.getPrototypeOf(field) as object;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
        field,
        value,
      );
      field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  const blur = (field: HTMLElement) =>
    act(async () => {
      field.focus();
      field.blur();
    });
  const pick = async (owner: string, icon: string) => {
    pickedIcon = icon;
    await act(async () => picker(owner).click());
    await settle();
  };
  const click = async (owner: string, label: string) => {
    const target = button(owner, label)!;
    target.focus();
    await act(async () => target.click());
    await settle();
  };
  const verifies = () =>
    commands.filter(
      (command) =>
        command === "repository_access_verify" ||
        command === "repository_access_activate",
    ).length;

  setLocale("en", { reload: false });
  const root = createRoot(doc.getElementById("app")!);
  await act(async () =>
    root.render(
      <ProjectGeneralSection
        projectPath="/project"
        projectName="Project"
        projectIcon="📁"
        spaces={spaces}
        gitTypes={{ docs: "independent", notes: "independent" }}
        reveal={{ owner: null, request: {} }}
      />,
    ),
  );
  await settle();

  test("a refused write shows its owner's recovery, keeps the draft and never checks access by itself", async () => {
    expect(nameInput("Docs").value).toBe("Docs");
    expect(verifies()).toBe(0);

    await pick("Docs", "🚀");
    expect(recovery("Docs") !== null).toBe(true);
    expect(
      recovery("Docs")!.textContent!.includes(
        m.git_access_reason_not_checked(),
      ),
    ).toBe(true);
    expect(button("Docs", m.git_access_action_check()) !== undefined).toBe(
      true,
    );
    expect(recovery("Project")).toBeNull();
    expect(recovery("Notes")).toBeNull();
    expect(picker("Docs").dataset.emojiPicker).toBe("🚀");
    expect(configs["/project/docs"].icon).toBe("📘");
    expect(patches).toEqual([]);
    expect(toasts).toEqual([]);
    expect(verifies()).toBe(0);

    // Edits while the recovery is open stay drafts for its retry.
    const before = commands.filter((c) => c === "save_space_config").length;
    await type(nameInput("Docs"), "  Docs renamed ");
    await blur(nameInput("Docs"));
    await type(descriptionInput("Docs"), "About docs");
    await blur(descriptionInput("Docs"));
    await settle();
    expect(commands.filter((c) => c === "save_space_config").length).toBe(
      before,
    );
    expect(nameInput("Docs").value).toBe("  Docs renamed ");
    expect(patches).toEqual([]);
    expect(verifies()).toBe(0);
  });

  test("the explicit retry after a check writes every draft of the block at once", async () => {
    await click("Docs", m.git_access_action_check());
    expect(verifies()).toBe(1);
    expect(saves).toEqual([]);
    expect(button("Docs", retryLabel()) !== undefined).toBe(true);

    await click("Docs", retryLabel());
    expect(saves).toEqual([
      {
        spacePath: "/project/docs",
        configData: {
          name: "Docs renamed",
          description: "About docs",
          icon: "🚀",
        },
        projectPath: "/project",
      } as never,
    ]);
    expect(patches).toEqual([
      [
        "/project/docs",
        { name: "Docs renamed", description: "About docs", icon: "🚀" },
      ],
    ]);
    expect(recovery("Docs")).toBeNull();
    expect(nameInput("Docs").value).toBe("Docs renamed");
    expect(doc.activeElement).toBe(nameInput("Docs"));
    expect(toasts).toEqual([]);
  });

  test("a retry the gate refuses again shows the recovery again", async () => {
    patches.length = 0;
    saves.length = 0;
    await type(nameInput("Project"), "Project renamed");
    await blur(nameInput("Project"));
    await settle();
    expect(recovery("Project") !== null).toBe(true);
    expect(recovery("Docs")).toBeNull();
    expect(patches).toEqual([]);

    await click("Project", m.git_access_action_check());
    refuseNext.add("/project");
    await click("Project", retryLabel());
    expect(recovery("Project") !== null).toBe(true);
    expect(saves).toEqual([]);
    expect(patches).toEqual([]);
    expect(nameInput("Project").value).toBe("Project renamed");

    await click("Project", m.git_access_action_check());
    await click("Project", retryLabel());
    expect(recovery("Project")).toBeNull();
    expect(patches).toEqual([["/project", { name: "Project renamed" }]]);
    expect(toasts).toEqual([]);
  });

  test("a writable owner saves without recovery and other failures keep the notification", async () => {
    patches.length = 0;
    failNext.add("/project/notes");
    await pick("Notes", "🌙");
    expect(toasts.length).toBe(1);
    expect(recovery("Notes")).toBeNull();
    expect(picker("Notes").dataset.emojiPicker).toBe("📝");
    expect(patches).toEqual([]);

    await pick("Notes", "🌙");
    expect(recovery("Notes")).toBeNull();
    expect(patches).toEqual([["/project/notes", { icon: "🌙" }]]);
    expect(configs["/project/notes"].icon).toBe("🌙");
    expect(toasts.length).toBe(1);
    await act(async () => root.unmount());
    clearNativeMocks();
  });
}
