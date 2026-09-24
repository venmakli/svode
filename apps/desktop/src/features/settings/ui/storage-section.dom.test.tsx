import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { JSDOM } from "jsdom";
import type { UseSpaceStorageSettingsResult } from "../hooks/use-space-storage-settings";
import { editVariableDraft } from "../model/app-variable-draft";
import { catalogFixture, variableFixture } from "../model/testing/variables";

if (process.env.SVODE_STORAGE_SECTION_DOM !== "1") {
  test("storage section DOM scenarios", () => {
    const result = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_STORAGE_SECTION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
    expect(result.status).toBe(0);
  }, 30000);
} else {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost" },
  );
  const restore = installDomGlobals(dom);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  (bunTest as typeof bunTest & { afterAll(run: () => void): void }).afterAll(
    () => {
      restore();
      dom.window.close();
    },
  );
  const { createRoot } = await import("react-dom/client");
  const { setLocale } = await import("@/paraglide/runtime");
  const { StorageInheritedGroup, StorageSettingsSection, storageSummary } =
    await import("./storage-section");
  setLocale("en", { reload: false });
  const document = dom.window.document;
  const noop = () => {};
  let calls: string[] = [];
  const call = (name: string) => async () => {
    calls.push(name);
  };

  const entries = [
    variableFixture({
      name: "S3_ACCESS",
      kind: "secret",
      mode: "git",
      ownerLabel: "Testov",
    }),
    variableFixture({
      name: "S3_SECRET",
      kind: "secret",
      ownerLabel: "Testov",
    }),
    variableFixture(
      { name: "SHARED_KEY", kind: "secret", hasValue: false },
      { scope: "global" },
    ),
    variableFixture({ name: "PLAIN", kind: "variable", value: "plain" }),
  ];

  function s3Fixture(
    overrides: Record<string, unknown> = {},
  ): UseSpaceStorageSettingsResult["s3"] {
    return {
      bindings: {
        accessKey: { owner: { scope: "project" }, name: "S3_ACCESS" },
        secretKey: { owner: { scope: "project" }, name: "PLAIN" },
      },
      saved: { bindings: null, ready: true, error: null },
      loaded: true,
      loadError: null,
      variables: {
        catalog: catalogFixture(entries),
        loadError: false,
        recover: async () => {},
        refresh: async () => catalogFixture(entries),
      },
      entries,
      editor: null,
      pending: false,
      editorError: null,
      collision: false,
      stale: false,
      editedEntry: undefined,
      collisionAlternatives: [],
      testState: "idle",
      testError: null,
      canSave: true,
      canTest: true,
      canSubmit: true,
      begin: (role: string, editing: boolean) =>
        calls.push(`begin:${role}:${editing}`),
      cancel: () => {
        calls.push("cancel");
        return true;
      },
      submit: async () => true,
      test: async () => {},
      invalidateCheck: noop,
      reviewLatest: async () => {},
      select: (role: string, source: { name: string }) =>
        calls.push(`select:${role}:${source.name}`),
      updateDraft: noop,
      retry: noop,
      ...overrides,
    } as unknown as UseSpaceStorageSettingsResult["s3"];
  }

  function storageFixture(
    overrides: Partial<UseSpaceStorageSettingsResult> = {},
  ): UseSpaceStorageSettingsResult {
    return {
      assetsStrategy: "local",
      savedAssetsStrategy: "local",
      storageConfigLoaded: true,
      storageConfigError: false,
      retryStorageConfig: () => calls.push("retry"),
      s3: s3Fixture(),
      canSaveS3: true,
      canTestS3: true,
      testS3: call("testS3"),
      savedS3Config: null,
      projectAssetsStrategy: "lfs-s3",
      projectS3Config: null,
      projectConfigStatus: "loaded",
      projectDefaultApplied: false,
      inheritedFromProject: false,
      ownerSpaceId: null,
      binaryRoutingStatus: "v1",
      binaryRoutingVersion: 1,
      binaryRoutingIssue: null,
      binaryRoutingChanged: false,
      lfsExtensions: "png, psd",
      lfsThresholdEnabled: false,
      lfsThresholdMegabytes: "10",
      currentSpacePath: "/project",
      currentSpaceId: null,
      isRoot: true,
      pendingStrategy: null,
      pendingAssetCount: 0,
      lfsAvailable: true,
      lfsAvailabilityLoaded: true,
      lfsVersion: "3.7.1",
      applyingStrategy: false,
      strategyInFlight: null,
      canApplyStrategy: true,
      s3Endpoint: "https://s3.example.test",
      s3Bucket: "assets",
      s3Region: "eu-1",
      s3Prefix: "svode/abc",
      lfsState: "ready",
      lfsRepairInFlight: false,
      lfsRemoteDiagnostic: null,
      lfsRemoteDiagnosticInFlight: false,
      lfsRemoteAuthOpen: false,
      lfsRemoteAuthChallenge: null,
      lfsRemoteAuthSaving: false,
      lfsRemoteAuthError: null,
      lfsPolicyDiagnostic: {
        managedPolicyCurrent: true,
        uncoveredPaths: [],
        truncatedCount: 0,
        lfsDeclaration: null,
      },
      lfsPolicyDiagnosticLoading: false,
      lfsPolicyDiagnosticError: false,
      canUpdateLfsPolicy: false,
      setS3Endpoint: noop,
      setS3Bucket: noop,
      setS3Region: noop,
      setS3Prefix: noop,
      setLfsExtensions: noop,
      setLfsThresholdEnabled: noop,
      setLfsThresholdMegabytes: noop,
      selectStrategy: async (next) => {
        calls.push(`selectStrategy:${next}`);
      },
      applySelectedStrategy: call("applySelectedStrategy"),
      useProjectStorageSetting: call("useProjectStorageSetting"),
      saveS3: call("saveS3"),
      diagnoseLfsRemote: call("diagnoseLfsRemote"),
      repairLfs: call("repairLfs"),
      setLfsRemoteAuthDialogOpen: noop,
      saveLfsRemoteAuthAndRetry: async () => {},
      updateLfsPolicy: call("updateLfsPolicy"),
      refreshLfsPolicyDiagnostic: call("refreshLfsPolicyDiagnostic"),
      cancelPendingStrategy: noop,
      confirmPendingStrategy: async () => {},
      ...overrides,
    };
  }

  const root = createRoot(document.getElementById("app")!);
  async function render(settings: UseSpaceStorageSettingsResult) {
    calls = [];
    await act(async () => {
      root.render(
        <StorageSettingsSection
          settings={settings}
          projectName="Testov"
          onOpenProject={() => calls.push("openProject")}
        />,
      );
      await tick();
    });
  }
  const groups = () =>
    Array.from(document.querySelectorAll("#app > section")).map(
      (section) => section.querySelector("h3")?.textContent ?? null,
    );
  const group = (title: string) =>
    Array.from(document.querySelectorAll<HTMLElement>("#app > section")).find(
      (section) => section.querySelector("h3")?.textContent === title,
    )!;
  const buttons = (text: string, scope: ParentNode = document) =>
    Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => button.textContent === text,
    );
  const control = (label: string) => {
    const node = Array.from(document.querySelectorAll("label")).find(
      (item) => item.textContent === label,
    )!;
    return document.getElementById(node.htmlFor)!;
  };
  const press = async (button: HTMLElement) => {
    await act(async () => {
      button.click();
      await tick();
    });
  };
  const key = async (target: Element, value: string) => {
    await act(async () => {
      target.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true }),
      );
      await tick();
    });
  };
  const openSelect = async (trigger: HTMLElement) => {
    await act(async () => {
      trigger.focus();
      await tick();
    });
    await key(trigger, "ArrowDown");
    return Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    );
  };
  const closeSelect = async () => {
    const open = document.querySelector('[role="listbox"]');
    if (open) await key(open, "Escape");
  };
  const rowOf = (element: Element) =>
    element.closest('[data-slot="field"], [data-slot="item"]')!;

  test("the strategy is a rich Select: the trigger names it, the list explains every option", async () => {
    await render(storageFixture());
    expect(groups()).toEqual(["Strategy"]);
    const trigger = control("Storage strategy");
    expect(trigger.textContent).toBe("Local only");
    const options = await openSelect(trigger);
    expect(options.map((option) => option.textContent)).toEqual([
      "Local onlyNew files stay on this device and aren't added to Git.",
      "In GitNew files are stored in Git with your documents.",
      "Git LFS (Remote)New files and matching media are stored in Git LFS with your Git provider.",
      "Git LFS + S3New files and matching media use Git LFS, with their contents stored in S3.",
    ]);
    expect(
      document
        .querySelector('[role="option"][data-state="checked"]')
        ?.textContent?.startsWith("Local only"),
    ).toBe(true);
    await closeSelect();
    expect(trigger.textContent).toBe("Local only");
    const lfs = rowOf(
      Array.from(document.querySelectorAll('[data-slot="item-title"]')).find(
        (node) => node.textContent === "git-lfs",
      )!,
    );
    expect(lfs.textContent?.includes("Version 3.7.1")).toBe(true);
    expect(lfs.textContent?.includes("Installed")).toBe(true);
    expect(buttons("Apply storage strategy").length).toBe(0);
    // One card per group; the old option cards and nested cards are gone.
    expect(document.querySelector('[role="radiogroup"]')).toBeNull();
    expect(
      document.querySelectorAll('[data-slot="card"] [data-slot="card"]').length,
    ).toBe(0);
  });

  test("without git-lfs the LFS options are unavailable and say why", async () => {
    await render(storageFixture({ lfsAvailable: false, lfsVersion: null }));
    const options = await openSelect(control("Storage strategy"));
    const disabled = options
      .filter((option) => option.hasAttribute("data-disabled"))
      .map((option) => option.textContent);
    expect(disabled).toEqual([
      "Git LFS (Remote)Requires git-lfs",
      "Git LFS + S3Requires git-lfs",
    ]);
    await closeSelect();
    const lfs = rowOf(
      Array.from(document.querySelectorAll('[data-slot="item-title"]')).find(
        (node) => node.textContent === "git-lfs",
      )!,
    );
    expect(lfs.textContent?.includes("Not found")).toBe(true);
    expect(lfs.textContent?.includes("brew install git-lfs")).toBe(true);
  });

  test("a draft is applied by one action at the end of the last group it needs", async () => {
    // In Git: the strategy group itself.
    await render(storageFixture({ assetsStrategy: "in-git" }));
    expect(groups()).toEqual(["Strategy"]);
    expect(
      rowOf(control("Storage strategy")).textContent?.includes("Not applied"),
    ).toBe(true);
    expect(control("Storage strategy").textContent).toBe("In Git");
    let apply = buttons("Apply storage strategy");
    expect(apply.length).toBe(1);
    expect(group("Strategy").contains(apply[0])).toBe(true);
    await press(apply[0]);
    expect(calls).toEqual(["applySelectedStrategy"]);

    // Git LFS (Remote): after the LFS rules, which have no save of their own.
    await render(storageFixture({ assetsStrategy: "lfs-remote" }));
    expect(groups()).toEqual(["Strategy", "Files in Git LFS"]);
    apply = buttons("Apply storage strategy");
    expect(apply.length).toBe(1);
    expect(group("Files in Git LFS").contains(apply[0])).toBe(true);
    expect(buttons("Save rules").length).toBe(0);
    await press(apply[0]);
    expect(calls).toEqual(["applySelectedStrategy"]);

    // Git LFS + S3: in the S3 group next to its connection check; saving S3
    // is no second way to apply.
    await render(storageFixture({ assetsStrategy: "lfs-s3" }));
    expect(groups()).toEqual(["Strategy", "Files in Git LFS", "S3 storage"]);
    apply = buttons("Apply storage strategy");
    expect(apply.length).toBe(1);
    const s3 = group("S3 storage");
    expect(s3.contains(apply[0])).toBe(true);
    expect(buttons("Check connection", s3).length).toBe(1);
    expect(apply[0].parentElement).toBe(
      buttons("Check connection", s3)[0].parentElement,
    );
    expect(buttons("Save", s3).length).toBe(0);
    await press(apply[0]);
    expect(calls).toEqual(["applySelectedStrategy"]);
    await press(buttons("Check connection", s3)[0]);
    expect(calls).toEqual(["applySelectedStrategy", "testS3"]);

    // A draft that cannot be applied yet keeps its single action disabled.
    await render(
      storageFixture({ assetsStrategy: "lfs-s3", canApplyStrategy: false }),
    );
    expect(buttons("Apply storage strategy")[0].disabled).toBe(true);
  });

  test("an enabled strategy locks the Select with its reason and saves S3 and rules on their own", async () => {
    await render(
      storageFixture({
        assetsStrategy: "lfs-s3",
        savedAssetsStrategy: "lfs-s3",
        lfsState: "ready",
      }),
    );
    expect(groups()).toEqual([
      "Strategy",
      "Files in Git LFS",
      "S3 storage",
      "Health",
    ]);
    const trigger = control("Storage strategy") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    expect(
      rowOf(trigger).textContent?.includes(
        "Changing the strategy after sync is on isn't supported yet.",
      ),
    ).toBe(true);
    await openSelect(trigger);
    expect(document.querySelectorAll('[role="option"]').length).toBe(0);
    expect(calls).toEqual([]);
    expect(buttons("Apply storage strategy").length).toBe(0);

    const s3 = group("S3 storage");
    await press(buttons("Save", s3)[0]);
    expect(calls).toEqual(["saveS3"]);

    const rules = group("Files in Git LFS");
    expect(buttons("Save rules", rules)[0].disabled).toBe(true);
    await render(
      storageFixture({
        assetsStrategy: "lfs-s3",
        savedAssetsStrategy: "lfs-s3",
        binaryRoutingChanged: true,
        canUpdateLfsPolicy: true,
      }),
    );
    await press(buttons("Save rules", group("Files in Git LFS"))[0]);
    expect(calls).toEqual(["updateLfsPolicy"]);
  });

  test("LFS rules: formats are a stacked picker, size is a row, errors sit under their row", async () => {
    await render(
      storageFixture({
        assetsStrategy: "lfs-remote",
        lfsThresholdEnabled: true,
        binaryRoutingIssue: "invalid-threshold",
      }),
    );
    const rules = group("Files in Git LFS");
    const formats = rules.querySelector('[role="group"][aria-labelledby]')!;
    const formatsRow = formats.closest('[data-slot="field"]')!;
    expect(formatsRow.getAttribute("data-orientation")).toBe("vertical");
    expect(
      document.getElementById(formats.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("File formats");
    expect(formatsRow.textContent?.includes("Selected: 2")).toBe(true);
    const size = control("Files from");
    expect(rowOf(size).getAttribute("data-orientation")).toBe("horizontal");
    expect(size.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(size.getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe("Enter a size greater than 0 MB.");

    await render(
      storageFixture({
        assetsStrategy: "lfs-remote",
        binaryRoutingStatus: "unsupported",
        binaryRoutingVersion: 2,
      }),
    );
    const locked = group("Files in Git LFS");
    expect(
      locked.textContent?.includes(
        "These LFS rules were created by a newer Svode version.",
      ),
    ).toBe(true);
    expect(locked.querySelector('[data-slot="card"]')).toBeNull();
    expect((control("Storage strategy") as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  test("S3: Endpoint spans the row, the keys are rich Selects of Secrets, the editor opens under its key", async () => {
    await render(storageFixture({ assetsStrategy: "lfs-s3" }));
    const endpoint = control("Endpoint");
    expect(rowOf(endpoint).getAttribute("data-orientation")).toBe("vertical");
    for (const label of ["Bucket", "Region", "Prefix"])
      expect(rowOf(control(label)).getAttribute("data-orientation")).toBe(
        "horizontal",
      );
    expect(endpoint.getAttribute("autocorrect")).toBe("off");

    const access = control("Access Key");
    expect(access.textContent).toBe("S3_ACCESS");
    expect(rowOf(access).textContent?.includes("Testov · Git")).toBe(true);
    const options = await openSelect(access);
    expect(options.map((option) => option.textContent)).toEqual([
      "S3_ACCESSTestov · Git",
      "S3_SECRETTestov · Local",
      "SHARED_KEYGlobal · Value is not set on this device",
    ]);
    await act(async () => {
      options[1].focus();
      await tick();
    });
    await key(options[1], "Enter");
    expect(calls).toEqual(["select:accessKey:S3_SECRET"]);

    // A bound entry that is no Secret stays visible, unavailable, with why.
    const secret = control("Secret Key");
    expect(secret.textContent).toBe("PLAIN");
    expect(secret.getAttribute("aria-invalid")).toBe("true");
    expect(
      document
        .getElementById(secret.getAttribute("aria-describedby")!)
        ?.textContent?.includes(
          "Secret PLAIN is missing, empty, or has a different type",
        ),
    ).toBe(true);
    const secretOptions = await openSelect(secret);
    expect(secretOptions[0].textContent).toBe(
      "PLAINOrdinary variable, not a Secret",
    );
    expect(secretOptions[0].hasAttribute("data-disabled")).toBe(true);
    await closeSelect();

    calls = [];
    await press(buttons("Edit", rowOf(access))[0]);
    expect(calls).toEqual(["begin:accessKey:true"]);

    await render(
      storageFixture({
        assetsStrategy: "lfs-s3",
        s3: s3Fixture({
          editor: { role: "accessKey", draft: editVariableDraft(entries[0]) },
        }),
      }),
    );
    const form = document.querySelector<HTMLFormElement>(
      'form[aria-label="Access Key: Edit"]',
    )!;
    expect(form.previousElementSibling?.getAttribute("data-slot")).toBe(
      "separator",
    );
    expect(
      form.previousElementSibling?.previousElementSibling?.contains(
        control("Access Key"),
      ),
    ).toBe(true);
    const fixedSecret =
      form.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(fixedSecret.disabled).toBe(true);
    expect(fixedSecret.getAttribute("data-state")).toBe("checked");
    expect((control("Access Key") as HTMLButtonElement).disabled).toBe(true);
    expect(buttons("Create Secret")[0].disabled).toBe(true);
    await key(form.querySelector("input")!, "Escape");
    expect(calls).toEqual(["cancel"]);
  });

  test("Health: LFS objects, the repository policy and the provider remote with its output", async () => {
    await render(
      storageFixture({
        assetsStrategy: "lfs-remote",
        savedAssetsStrategy: "lfs-remote",
        lfsState: "missing-creds",
        lfsRemoteDiagnostic: {
          state: "missing-creds",
          reason: "auth-required",
          authMethod: "https",
          remoteUrl: "https://git.example.test/repo.git",
          terminalCommand: "git lfs install",
          detail: "fatal: Authentication failed",
        },
      }),
    );
    const health = group("Health");
    expect(
      health.textContent?.includes(
        "No access to the Git LFS remote — check it below.",
      ),
    ).toBe(true);
    expect(buttons("Download binaries", health).length).toBe(0);
    expect(health.textContent?.includes("Repository LFS policy")).toBe(true);
    expect(health.textContent?.includes("Up to date")).toBe(true);
    expect(
      health.textContent?.includes("Remote access is missing or was rejected."),
    ).toBe(true);
    expect(
      health.textContent?.includes("https://git.example.test/repo.git"),
    ).toBe(true);
    expect(health.textContent?.includes("git lfs install")).toBe(true);
    await press(buttons("Sign in to remote", health)[0]);
    expect(calls).toEqual(["diagnoseLfsRemote"]);
    expect(health.textContent?.includes("fatal: Authentication failed")).toBe(
      false,
    );
    await press(buttons("Show", health)[0]);
    expect(health.textContent?.includes("fatal: Authentication failed")).toBe(
      true,
    );

    await render(
      storageFixture({
        assetsStrategy: "lfs-s3",
        savedAssetsStrategy: "lfs-s3",
        lfsState: "ready",
      }),
    );
    const ready = group("Health");
    expect(ready.textContent?.includes("Git LFS remote")).toBe(false);
    await press(buttons("Download binaries", ready)[0]);
    expect(calls).toEqual(["repairLfs"]);
  });

  test("a space repository offers the project setting first and says why it cannot take it", async () => {
    const space = { isRoot: false, currentSpaceId: "docs" };
    await render(storageFixture(space));
    expect(groups()).toEqual(["Project setting", "Strategy"]);
    const setting = group("Project setting");
    expect(
      setting.textContent?.includes("Project “Testov”: Git LFS + S3"),
    ).toBe(true);
    expect(
      setting.textContent?.includes(
        "The project setting fills in Endpoint, Bucket, and Region",
      ),
    ).toBe(true);
    await press(buttons("Use project setting", setting)[0]);
    expect(calls).toEqual(["useProjectStorageSetting"]);

    await render(
      storageFixture({
        ...space,
        assetsStrategy: "in-git",
        savedAssetsStrategy: "in-git",
      }),
    );
    const blocked = group("Project setting");
    expect(buttons("Use project setting", blocked)[0].disabled).toBe(true);
    expect(
      blocked.textContent?.includes(
        "Changing the strategy after sync is on isn't supported yet.",
      ),
    ).toBe(true);

    await render(storageFixture({ ...space, projectDefaultApplied: true }));
    expect(buttons("Use project setting").length).toBe(0);
    expect(group("Project setting").textContent?.includes("Applied")).toBe(
      true,
    );

    await render(storageFixture({ ...space, projectConfigStatus: "loading" }));
    expect(group("Project setting").getAttribute("aria-busy")).toBe("true");
    expect(group("Project setting").querySelector('[data-slot="item"]')).toBe(
      null,
    );
  });

  test("loading, a failed load and an inherited space", async () => {
    await render(storageFixture({ storageConfigLoaded: false }));
    expect(groups()).toEqual(["Strategy"]);
    expect(document.querySelector('[role="combobox"]')).toBeNull();
    await render(storageFixture({ lfsAvailabilityLoaded: false }));
    expect(document.querySelector('[role="combobox"]')).toBeNull();

    await render(storageFixture({ storageConfigError: true }));
    expect(group("Strategy").querySelector('[data-slot="card"]')).toBeNull();
    await press(buttons("Retry")[0]);
    expect(calls).toEqual(["retry"]);

    await render(
      storageFixture({
        isRoot: false,
        inheritedFromProject: true,
        savedAssetsStrategy: "in-git",
        assetsStrategy: "in-git",
      }),
    );
    expect(
      document.body.textContent?.includes(
        "Uses the “Testov” project strategy: In Git",
      ),
    ).toBe(true);
    await press(buttons("Project storage")[0]);
    expect(calls).toEqual(["openProject"]);

    await act(async () => {
      root.render(
        <StorageInheritedGroup
          projectName="Testov"
          strategy={null}
          onOpenProject={noop}
        />,
      );
      await tick();
    });
    expect(
      document.body.textContent?.includes("Uses the “Testov” project strategy"),
    ).toBe(true);
    expect(document.body.textContent?.includes("strategy:")).toBe(false);
  });

  test("a collapsed repository block summarizes its strategy and the project setting", () => {
    const space = { isRoot: false, savedAssetsStrategy: "in-git" } as const;
    expect(storageSummary(storageFixture(space))).toBe(
      "Strategy: In Git · Project setting: differs",
    );
    expect(
      storageSummary(storageFixture({ ...space, projectDefaultApplied: true })),
    ).toBe("Strategy: In Git · Project setting: applied");
    expect(
      storageSummary(
        storageFixture({ ...space, projectConfigStatus: "loading" }),
      ),
    ).toBe("Strategy: In Git");
    expect(
      storageSummary(storageFixture({ ...space, storageConfigLoaded: false })),
    ).toBe(null);
    setLocale("ru", { reload: false });
    expect(storageSummary(storageFixture(space))).toBe(
      "Стратегия: В Git · Настройка проекта: отличается",
    );
    setLocale("en", { reload: false });
  });
}

function installDomGlobals(dom: JSDOM) {
  const values: Record<string, unknown> = {
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLButtonElement: dom.window.HTMLButtonElement,
    DocumentFragment: dom.window.DocumentFragment,
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
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function tick() {
  return new Promise<void>((resolve) => setTimeout(resolve, 20));
}
