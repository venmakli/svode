import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import { Bot } from "lucide-react";

import type {
  AgentSetupDto,
  CustomAgentDefinitionDto,
  CustomAgentSetupDto,
  McpClientStatus,
  McpStatus,
} from "../api";
import { APP_SETTINGS_NAV_ITEMS } from "./app-settings-navigation";

// Radix chooses its layout effect when it loads, so the UI is imported once
// a document exists.
let ProvidersSection: typeof import("./providers-section").ProvidersSection;
const signInTerminals = {
  closed: [] as string[],
  exit: null as ((ptyId: string) => void) | null,
};

const isolatedProcess = process.env.SVODE_PROVIDERS_SECTION_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("Providers section DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_PROVIDERS_SECTION_DOM_PROCESS: "1",
        },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) {
      throw new Error([child.stdout, child.stderr].filter(Boolean).join("\n"));
    }
    expect(child.status).toBe(0);
  });
} else {
  const { mock } = bunTest as typeof bunTest & {
    mock: { module(path: string, factory: () => unknown): void };
  };
  installDomGlobals(createDom());
  mock.module("@/features/terminal/session-surface", () => ({
    ManagedTerminalSurface: ({ ptyId }: { ptyId: string }) => (
      <div data-terminal={ptyId} />
    ),
    closeManagedTerminalSurface: async (ptyId: string) => {
      signInTerminals.closed.push(ptyId);
    },
    subscribeManagedTerminalExit: (listener: (ptyId: string) => void) => {
      signInTerminals.exit = listener;
      return () => {
        if (signInTerminals.exit === listener) signInTerminals.exit = null;
      };
    },
  }));
  ({ ProvidersSection } = await import("./providers-section"));

  test("the section shows the agents, the Svode integration with its installed parts and the runtime once, without an access switch, details or a PII alert", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    let canonical = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const document = harness.dom.window.document;
      const [agents, integration, runtime] = topSections(harness.dom);
      expect(agents.querySelector("h2, h3, h4")).toBeNull();
      expect(
        agents.textContent?.includes(
          "Use the agents found on this device in Svode chat and sessions",
        ),
      ).toBe(true);
      expect(within(agents, "Refresh") !== undefined).toBe(true);
      expect(agents.querySelectorAll("[data-agent]").length).toBe(2);

      expect(integration.hasAttribute("data-svode-integration")).toBe(true);
      expect(integration.querySelector("h3")?.textContent).toBe(
        "Svode integration",
      );
      expect(partRows(integration)).toEqual([
        ["Svode plugin", "Claude Code"],
        ["Svode MCP", "Codex"],
        ["Shared skill", "Read by Codex"],
        [
          "Manual MCP setup",
          "A standard mcpServers entry for an agent Svode does not set up",
        ],
      ]);
      expect(within(integration, "Manage…") !== undefined).toBe(true);

      // One permanent list of agents: switches belong to agent rows only,
      // and no row of the page has an access switch or expandable details.
      expect(document.querySelectorAll('button[role="switch"]').length).toBe(2);
      expect(
        Array.from(document.querySelectorAll('button[role="switch"]')).every(
          (toggle) => toggle.closest("[data-agent]"),
        ),
      ).toBe(true);
      expect(document.querySelector("[data-mcp-client]")).toBeNull();
      expect(findButton(harness.dom, "Details") === undefined).toBe(true);
      expect(
        /Svode access|External agent access/.test(
          document.body.textContent ?? "",
        ),
      ).toBe(false);

      expect(runtime.hasAttribute("data-mcp-runtime")).toBe(true);
      expect(runtime.querySelector("h3")?.textContent).toBe("Svode runtime");
      const runtimeText = runtime.textContent ?? "";
      expect(runtimeText.includes("/Users/test/.svode/bin/svode-mcp")).toBe(
        true,
      );
      expect(runtimeText.includes("0.0.9 (Svode Desktop)")).toBe(true);

      canonical = {
        ...canonical,
        doctor: {
          ok: false,
          messages: ["runtime 0.0.9"],
          errors: ["bridge is not running"],
          bridgeCompatible: true,
        },
      };
      await act(async () => {
        within(runtime, "Run check").click();
        await settle();
      });
      expect((runtime.textContent ?? "").includes("Needs attention")).toBe(
        true,
      );
      await act(async () => {
        within(runtime, "Show report").click();
        await settle();
      });
      expect(
        (runtime.textContent ?? "").includes("bridge is not running"),
      ).toBe(true);

      expect(
        APP_SETTINGS_NAV_ITEMS.find((item) => item.key === "providers")?.icon,
      ).toBe(Bot);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian: with nothing installed the block explains it and Install… opens the Svode tools dialog with the data warning", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", false),
      client("codex", "Codex", false),
    ]);
    const harness = await renderSection(
      () => status,
      () => {},
    );
    try {
      const [, integration] = topSections(harness.dom);
      expect(partRows(integration)).toEqual([
        ["Инструменты Svode пока не установлены ни одному агенту.", ""],
        [
          "Ручная настройка MCP",
          "Стандартная запись mcpServers для агента, которого Svode не настраивает",
        ],
      ]);
      expect(within(integration, "Управлять…") === undefined).toBe(true);
      await act(async () => {
        within(integration, "Установить…").click();
        await settle();
      });
      const dialog =
        harness.dom.window.document.querySelector<HTMLElement>(
          "[data-svode-tools]",
        )!;
      expect(dialog.querySelector("h2")?.textContent).toBe("Инструменты Svode");
      expect(
        (dialog.textContent ?? "").includes(
          "Агенты с инструментами Svode могут читать и изменять данные проектов Svode",
        ),
      ).toBe(true);
      expect(toolsAgents(dialog)).toEqual([
        ["codex", "Codex", "MCP и общий skill", "false", "enabled"],
        ["claude-code", "Claude Code", "Плагин", "false", "enabled"],
      ]);
      // Nothing to remove yet: the shared skill comes with the agents.
      expect(
        dialog.querySelector(
          "[data-tools-shared] [data-slot=field-description]",
        )?.textContent,
      ).toBe("Читают: Codex · Ставится вместе с агентами, которым он нужен");
      expect(within(dialog, "Применить").disabled).toBe(true);
      expect(harness.commands.includes("mcp_print_config")).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("a part problem shows in its row with Fix when reconnecting completes it, and an installation outside Svode shows its source", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    let canonical = providersStatus([
      client("claude-code", "Claude Code", false, {
        ownPart: {
          kind: "plugin",
          path: "/Users/test/.claude/plugins/svode",
          state: "external",
          source: "the Claude Code marketplace",
        },
      }),
      client("codex", "Codex", true, {
        status: "attention",
        attentionCode: "incomplete",
        issues: [{ code: "incomplete", message: "skill missing" }],
      }),
    ]);
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const [, integration] = topSections(harness.dom);
      expect(partRows(integration).slice(0, 3)).toEqual([
        ["Shared skill", "Read by Codex"],
        [
          "Svode plugin",
          "Claude Code · Installed outside Svode from the Claude Code marketplace",
        ],
        ["Svode MCP", "Codex · Part of the kit is missing"],
      ]);
      const codexPart = integration.querySelector<HTMLElement>(
        '[data-integration-part="problem:codex"]',
      )!;
      expect(within(codexPart, "Fix") !== undefined).toBe(true);
      expect(
        integration.querySelector(
          '[data-integration-part="external:claude-code"] button',
        ),
      ).toBeNull();
      await act(async () => {
        within(codexPart, "Fix").click();
        await settle();
      });
      expect(harness.installed).toEqual(["codex"]);
      expect(partRows(integration).slice(0, 2)).toEqual([
        ["Svode MCP", "Codex"],
        ["Shared skill", "Read by Codex"],
      ]);
      expect(
        integration.querySelector("[data-integration-restart]")?.textContent,
      ).toBe(
        "Agent sessions that are already open get the changes after a restart.",
      );
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian: a conflict, a failed install with Retry and the runtime callouts belong to the integration block", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const consoleError = console.error;
    console.error = () => {};
    let canonical = providersStatus([
      client("claude-code", "Claude Code", false),
      client("codex", "Codex", false, {
        status: "attention",
        attentionCode: "custom_conflict",
        issues: [{ code: "custom_conflict", message: "custom" }],
      }),
    ]);
    let failInstall = true;
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
      undefined,
      {
        mcp_install_client: () => {
          if (failInstall)
            throw { kind: "general", message: "config is locked" };
          return undefined;
        },
      },
    );
    try {
      const [agents, integration] = topSections(harness.dom);
      expect(partRows(integration)[0]).toEqual([
        "MCP Svode",
        "Codex · Конфликт: своя запись svode в /Users/test/.codex/config.toml",
      ]);
      // The conflict cannot be chosen in the dialog; Claude Code can.
      await act(async () => {
        within(integration, "Управлять…").click();
        await settle();
      });
      const document = harness.dom.window.document;
      let dialog = document.querySelector<HTMLElement>("[data-svode-tools]")!;
      expect(toolsAgents(dialog)).toEqual([
        [
          "codex",
          "Codex",
          "MCP и общий skill · Конфликт: своя запись svode в /Users/test/.codex/config.toml",
          "false",
          "disabled",
        ],
        ["claude-code", "Claude Code", "Плагин", "false", "enabled"],
      ]);
      await act(async () => {
        checkboxOf(dialog, "claude-code").click();
        await settle();
      });
      expect(summaryLines(dialog)).toEqual([
        "Установить плагин Svode для Claude Code",
      ]);
      await act(async () => {
        within(dialog, "Применить").click();
        await settle();
      });
      dialog = document.querySelector<HTMLElement>("[data-svode-tools]")!;
      expect(results(dialog)).toEqual([
        [
          "failed",
          "Установить плагин Svode для Claude CodeНе удалось: config is locked",
        ],
      ]);
      await act(async () => {
        within(dialog, "Закрыть").click();
        await settle();
      });
      // The failure stays on its part with Retry until it succeeds.
      const failed = integration.querySelector<HTMLElement>(
        '[data-integration-part="failed:claude-code"]',
      )!;
      expect(
        failed.textContent?.includes(
          "Claude Code · Не установлено: config is locked",
        ),
      ).toBe(true);
      failInstall = false;
      await act(async () => {
        within(failed, "Повторить").click();
        await settle();
      });
      expect(partRows(integration)[0]).toEqual(["Плагин Svode", "Claude Code"]);
      expect(agents.textContent?.includes("Svode runtime недоступен")).toBe(
        false,
      );

      canonical = {
        ...canonical,
        server: { status: "not_found", command: null },
      };
      await act(async () => {
        within(agents, "Обновить").click();
        await settle();
      });
      expect(
        integration
          .querySelector('[role="alert"]')
          ?.textContent?.includes("Svode runtime недоступен"),
      ).toBe(true);
      expect(agents.querySelector('[role="alert"]')).toBeNull();

      canonical = {
        ...canonical,
        server: providersStatus([]).server,
        doctor: { ...canonical.doctor, bridgeCompatible: false },
      };
      await act(async () => {
        within(agents, "Обновить").click();
        await settle();
      });
      expect(
        integration
          .querySelector('[role="alert"]')
          ?.textContent?.includes("Несовместимая версия bridge"),
      ).toBe(true);
    } finally {
      console.error = consoleError;
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("manual setup shows one standard mcpServers JSON", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(
      () => status,
      () => {},
    );
    try {
      const manual = harness.dom.window.document.querySelector<HTMLElement>(
        "[data-manual-config]",
      )!;
      await act(async () => {
        within(manual, "Show").click();
        await settle();
      });
      const config = manual.querySelector("textarea")!;
      expect(config.getAttribute("aria-label")).toBe("Manual MCP config");
      expect(JSON.parse(config.value)).toEqual({
        mcpServers: {
          svode: { command: "/Users/test/.svode/bin/svode-mcp", args: [] },
        },
      });
      expect(harness.commands.includes("mcp_print_config")).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("turning on offers Svode tools in the same confirmation and the adapter and the tools are independent results", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const consoleError = console.error;
    console.error = () => {};
    let canonical = providersStatus([
      client("claude-code", "Claude Code", false),
      client("codex", "Codex", false),
    ]);
    const enabled: string[] = [];
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
      [
        agentSetup("codex", {
          enabled: false,
          adapter: {
            ...agentSetup("codex").adapter!,
            install: { state: "not_installed" },
          },
        }),
        agentSetup("claude-code", { enabled: false }),
      ],
      {
        agent_setup_enable: ({ agent }) => {
          enabled.push(String(agent));
          if (agent === "codex")
            throw {
              kind: "agent_adapter",
              code: "download",
              package: "@agentclientprotocol/codex-acp",
              message: "offline",
            };
          return agentSetup("claude-code");
        },
        mcp_install_client: ({ client: id }) => {
          if (id === "claude-code")
            throw { kind: "general", message: "plugin folder is read-only" };
          return undefined;
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      await act(async () => {
        switchOf(agentRow(harness.dom, "codex")).click();
        await settle();
      });
      let dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      const text = dialog.textContent ?? "";
      expect(text.includes("Turn on Codex?")).toBe(true);
      expect(text.includes("@agentclientprotocol/codex-acp 2.1.1")).toBe(true);
      expect(text.includes("Add Svode tools")).toBe(true);
      expect(
        text.includes(
          "Adds the Svode MCP server to Codex and the shared skill with the svode command.",
        ),
      ).toBe(true);
      expect(
        text.includes(
          "Codex will be able to read and change the data of Svode projects, including personal data.",
        ),
      ).toBe(true);
      expect(
        dialog
          .querySelector('button[role="checkbox"]')
          ?.getAttribute("aria-checked"),
      ).toBe("true");
      await act(async () => {
        within(dialog, "Turn on").click();
        await settle();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(enabled).toEqual(["codex"]);
      expect(harness.installed).toEqual(["codex"]);
      // The adapter failed in the row; the tools went in independently.
      expect(stateOf(agentRow(harness.dom, "codex"))).toBe(
        "Adapter not installed: the download failed",
      );
      const [, integration] = topSections(harness.dom);
      expect(partRows(integration).slice(0, 2)).toEqual([
        ["Svode MCP", "Codex"],
        ["Shared skill", "Read by Codex"],
      ]);

      // Claude Code needs no adapter: the confirmation is about the tools,
      // which fail on their own while the agent turns on.
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(
        (dialog.textContent ?? "").includes(
          "Claude Code becomes available in Svode chat and sessions.",
        ),
      ).toBe(true);
      expect(
        (dialog.textContent ?? "").includes(
          "Installs the Svode plugin: the skill, the svode command and the Svode MCP server.",
        ),
      ).toBe(true);
      await act(async () => {
        within(dialog, "Turn on").click();
        await settle();
      });
      expect(enabled).toEqual(["codex", "claude-code"]);
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe("Ready");
      expect(
        integration
          .querySelector('[data-integration-part="failed:claude-code"]')
          ?.textContent?.includes(
            "Claude Code · Not installed: plugin folder is read-only",
          ),
      ).toBe(true);
    } finally {
      console.error = consoleError;
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian: unchecking the tools only turns the agent on, and turning off asks only when Svode can remove the agent's own part and removes nothing by default", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    let canonical = providersStatus([
      client("claude-code", "Claude Code", false),
      client("codex", "Codex", true),
    ]);
    const enabled: string[] = [];
    const disabled: string[] = [];
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
      [agentSetup("codex"), agentSetup("claude-code", { enabled: false })],
      {
        agent_setup_enable: ({ agent }) => {
          enabled.push(String(agent));
          return agentSetup(String(agent));
        },
        agent_setup_disable: ({ agent }) => {
          disabled.push(String(agent));
          return agentSetup(String(agent), { enabled: false });
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      let dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(dialog.querySelector("h2")?.textContent).toBe(
        "Включить Claude Code?",
      );
      await act(async () => {
        dialog
          .querySelector<HTMLButtonElement>('button[role="checkbox"]')!
          .click();
        await settle();
      });
      await act(async () => {
        within(dialog, "Включить").click();
        await settle();
      });
      expect(enabled).toEqual(["claude-code"]);
      expect(harness.installed).toEqual([]);

      // Turning off asks for Codex, which has its own part; the option to
      // remove it is off, and the shared skill is offered only with it.
      await act(async () => {
        switchOf(agentRow(harness.dom, "codex")).click();
        await settle();
      });
      dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(dialog.querySelector("h2")?.textContent).toBe("Выключить Codex?");
      expect(
        (dialog.textContent ?? "").includes(
          "MCP Svode перестанет работать и в терминале Codex. Общий skill сохранится.",
        ),
      ).toBe(true);
      expect(checkboxes(dialog)).toEqual([
        ["Также удалить MCP Svode", "false"],
      ]);
      await act(async () => {
        within(dialog, "Выключить").click();
        await settle();
      });
      expect(disabled).toEqual(["codex"]);
      expect(harness.removed).toEqual([]);

      // Turned on again, Codex goes off with its own part and the shared
      // skill no other agent reads.
      await act(async () => {
        switchOf(agentRow(harness.dom, "codex")).click();
        await settle();
      });
      expect(enabled).toEqual(["claude-code", "codex"]);
      await act(async () => {
        switchOf(agentRow(harness.dom, "codex")).click();
        await settle();
      });
      dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      await act(async () => {
        dialog
          .querySelector<HTMLButtonElement>('button[role="checkbox"]')!
          .click();
        await settle();
      });
      expect(checkboxes(dialog)).toEqual([
        ["Также удалить MCP Svode", "true"],
        ["Также удалить общий skill", "false"],
      ]);
      await act(async () => {
        dialog
          .querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')[1]!
          .click();
        await settle();
      });
      await act(async () => {
        within(dialog, "Выключить").click();
        await settle();
      });
      expect(harness.removed).toEqual(["codex", "#shared"]);
      const [, integration] = topSections(harness.dom);
      expect(
        integration.querySelector("[data-integration-empty]") === null,
      ).toBe(false);

      // An agent without an own part turns off at once.
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(disabled).toEqual(["codex", "codex", "claude-code"]);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Manage…: a summary before applying, a partial success with retry, and the shared skill stays while a checked agent needs it", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const consoleError = console.error;
    console.error = () => {};
    let canonical = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    let sharedAttempts = 0;
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
      [
        agentSetup("codex"),
        agentSetup("claude-code"),
        deferredSetup("hermes", true),
      ],
      {
        mcp_remove_shared_skill: () => {
          sharedAttempts += 1;
          if (sharedAttempts === 1)
            throw { kind: "general", message: "the skill folder is busy" };
          return undefined;
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      const [, integration] = topSections(harness.dom);
      await act(async () => {
        within(integration, "Manage…").click();
        await settle();
      });
      let dialog = document.querySelector<HTMLElement>("[data-svode-tools]")!;
      expect(toolsAgents(dialog)).toEqual([
        [
          "codex",
          "Codex",
          "MCP and shared skill · Installed",
          "true",
          "enabled",
        ],
        ["claude-code", "Claude Code", "Plugin · Installed", "true", "enabled"],
        ["hermes", "Hermes", "Not supported yet", "false", "disabled"],
      ]);
      const shared = () =>
        dialog.querySelector<HTMLButtonElement>(
          '[data-tools-shared] button[role="checkbox"]',
        )!;
      expect(shared().getAttribute("aria-checked")).toBe("true");
      expect(shared().disabled).toBe(true);
      expect(
        dialog.querySelector(
          "[data-tools-shared] [data-slot=field-description]",
        )?.textContent,
      ).toBe("Read by Codex · Needed by Codex");
      expect(summaryLines(dialog)).toEqual(["Nothing to change"]);
      expect(within(dialog, "Apply").disabled).toBe(true);

      await act(async () => {
        checkboxOf(dialog, "codex").click();
        await settle();
      });
      expect(shared().disabled).toBe(false);
      await act(async () => {
        shared().click();
        await settle();
      });
      expect(summaryLines(dialog)).toEqual([
        "Remove Svode MCP from Codex",
        "Remove the shared skill: it stops working for Codex",
      ]);
      await act(async () => {
        within(dialog, "Apply").click();
        await settle();
      });
      dialog = document.querySelector<HTMLElement>("[data-svode-tools]")!;
      expect(results(dialog)).toEqual([
        ["done", "Remove Svode MCP from CodexDone"],
        [
          "failed",
          "Remove the shared skill: it stops working for CodexFailed: the skill folder is busy",
        ],
      ]);
      await act(async () => {
        within(dialog, "Retry failed").click();
        await settle();
      });
      expect(results(dialog)).toEqual([
        ["done", "Remove Svode MCP from CodexDone"],
        ["done", "Remove the shared skill: it stops working for CodexDone"],
      ]);
      expect(harness.removed).toEqual(["codex", "#shared"]);
      expect(findButton(harness.dom, "Retry failed") === undefined).toBe(true);
      await act(async () => {
        within(dialog, "Close").click();
        await settle();
      });
      expect(document.querySelector("[data-svode-tools]")).toBeNull();
      expect(partRows(integration)[0]).toEqual(["Svode plugin", "Claude Code"]);
    } finally {
      console.error = consoleError;
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("an agent with an MCP entry of its own shares the MCP row, and an agent that only reads the shared skill is named there without a checkbox", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const base = providersStatus([
      client("codex", "Codex", false),
      client("claude-code", "Claude Code", false),
      client("opencode", "opencode", true, {
        configPath: "/Users/test/.config/opencode/opencode.json",
        ownPart: {
          kind: "mcp-entry",
          path: "/Users/test/.config/opencode/opencode.json",
          state: "managed",
        },
      }),
      client("grok-build", "Grok Build", false, {
        configPath: null,
        ownPart: null,
        limitation: "Grok Build starts MCP servers in its own directory",
      }),
    ]);
    const status: McpStatus = {
      ...base,
      sharedSkill: {
        ...base.sharedSkill,
        state: "managed",
        readers: ["codex", "opencode", "grok-build"],
        requiredBy: ["opencode"],
      },
    };
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex"),
        agentSetup("claude-code"),
        agentSetup("opencode"),
        agentSetup("grok-build"),
      ],
    );
    try {
      const [, integration] = topSections(harness.dom);
      expect(partRows(integration).slice(0, 2)).toEqual([
        ["Svode MCP", "opencode"],
        [
          "Shared skill",
          "Read by Codex, opencode, Grok Build · Skill and svode only, without Svode MCP: Grok Build",
        ],
      ]);
      await act(async () => {
        within(integration, "Manage…").click();
        await settle();
      });
      const dialog =
        harness.dom.window.document.querySelector<HTMLElement>(
          "[data-svode-tools]",
        )!;
      expect(toolsAgents(dialog)).toEqual([
        ["codex", "Codex", "MCP and shared skill", "false", "enabled"],
        ["claude-code", "Claude Code", "Plugin", "false", "enabled"],
        [
          "opencode",
          "opencode",
          "MCP and shared skill · Installed",
          "true",
          "enabled",
        ],
      ]);
      expect(
        dialog.querySelector(
          "[data-tools-shared] [data-slot=field-description]",
        )?.textContent,
      ).toBe(
        "Read by Codex, opencode, Grok Build · Skill and svode only, without Svode MCP: Grok Build · Needed by opencode",
      );
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Kimi Code shares the MCP row and Hermes gets a shared skill access row, its kit and its removal on turning off, in en and ru", async () => {
    const originalLocale = getLocale();
    const base = providersStatus([
      client("codex", "Codex", false),
      client("claude-code", "Claude Code", false),
      client("hermes", "Hermes", true, {
        configPath: "/Users/test/.hermes/config.yaml",
        ownPart: {
          kind: "skills-entry",
          path: "/Users/test/.hermes/config.yaml",
          state: "managed",
        },
        limitation: "Hermes starts MCP servers in its own directory",
      }),
      client("kimi-code", "Kimi Code", true, {
        configPath: "/Users/test/.kimi-code/mcp.json",
        ownPart: {
          kind: "mcp-entry",
          path: "/Users/test/.kimi-code/mcp.json",
          state: "managed",
        },
      }),
    ]);
    const status: McpStatus = {
      ...base,
      sharedSkill: {
        ...base.sharedSkill,
        state: "managed",
        readers: ["codex", "hermes", "kimi-code"],
        requiredBy: ["hermes", "kimi-code"],
      },
    };
    for (const [locale, text] of [
      [
        "en",
        {
          mcp: "Svode MCP",
          skills: "Shared skill access",
          shared: "Shared skill",
          readers: "Read by Codex, Hermes, Kimi Code",
          hermesKit: "Shared skill · Installed",
          kimiKit: "MCP and shared skill · Installed",
          removal: "Also remove shared skill access",
          cancel: "Cancel",
          manage: "Manage…",
        },
      ],
      [
        "ru",
        {
          mcp: "MCP Svode",
          skills: "Доступ к общему skill",
          shared: "Общий skill",
          readers: "Читают: Codex, Hermes, Kimi Code",
          hermesKit: "Общий skill · Установлено",
          kimiKit: "MCP и общий skill · Установлено",
          removal: "Также отключить общий skill",
          cancel: "Отмена",
          manage: "Управлять…",
        },
      ],
    ] as const) {
      await setLocale(locale, { reload: false });
      const harness = await renderSection(
        () => status,
        () => {},
        [
          agentSetup("codex"),
          agentSetup("claude-code"),
          agentSetup("hermes"),
          agentSetup("kimi-code"),
        ],
      );
      try {
        const [, integration] = topSections(harness.dom);
        expect(partRows(integration).slice(0, 3)).toEqual([
          [text.mcp, "Kimi Code"],
          [text.skills, "Hermes"],
          [text.shared, text.readers],
        ]);

        await act(async () => {
          switchOf(agentRow(harness.dom, "hermes")).click();
          await settle();
        });
        const off = harness.dom.window.document.querySelector<HTMLElement>(
          '[role="alertdialog"]',
        )!;
        expect((off.textContent ?? "").includes(text.removal)).toBe(true);
        await act(async () => {
          within(off, text.cancel).click();
          await settle();
        });

        await act(async () => {
          within(integration, text.manage).click();
          await settle();
        });
        const dialog =
          harness.dom.window.document.querySelector<HTMLElement>(
            "[data-svode-tools]",
          )!;
        const kits = Object.fromEntries(
          toolsAgents(dialog).map(([agent, , kit]) => [agent, kit]),
        );
        expect(kits.hermes).toBe(text.hermesKit);
        expect(kits["kimi-code"]).toBe(text.kimiKit);
      } finally {
        await harness.cleanup();
      }
    }
    await setLocale(originalLocale, { reload: false });
  });

  test("each found agent shows one state, a deferred agent cannot be turned on and missing agents are folded", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex", {
          cli: {
            ...agentSetup("codex").cli,
            version: "codex-cli 0.160.0",
          },
          cliVersion: { state: "untested", testedUpTo: "0.159.3" },
        }),
        agentSetup("claude-code", {
          enabled: false,
          adapter: {
            ...agentSetup("claude-code").adapter!,
            install: { state: "not_installed" },
            node: { state: "missing" },
          },
        }),
        deferredSetup("hermes", true),
        deferredSetup("kimi-code", false),
        deferredSetup("cursor", false),
      ],
    );
    try {
      const codex = agentRow(harness.dom, "codex");
      expect(title(codex)).toBe("Codex0.160.0");
      expect(stateOf(codex)).toBe(
        "Ready · CLI is newer than the tested 0.159.3",
      );
      expect(switchOf(codex).getAttribute("aria-checked")).toBe("true");
      expect(switchOf(codex).getAttribute("aria-label")).toBe(
        "Use Codex in Svode",
      );

      const claude = agentRow(harness.dom, "claude-code");
      expect(stateOf(claude)).toBe("Needs Node.js 22 or newer");
      expect(switchOf(claude).disabled).toBe(true);

      const hermes = agentRow(harness.dom, "hermes");
      expect(title(hermes)).toBe("Hermes0.18.2");
      expect(stateOf(hermes)).toBe("Not supported yet");
      expect(switchOf(hermes).disabled).toBe(true);
      expect(hermes.querySelector('[aria-label^="More actions"]')).toBeNull();

      // One list of agents: none of them is listed twice.
      const notFound = harness.dom.window.document.querySelector<HTMLElement>(
        "[data-agents-not-found]",
      )!;
      expect(summary(notFound).includes("Not found (2)")).toBe(true);
      expect(notFound.querySelector("a")).toBeNull();
      await act(async () => {
        within(notFound, "Show").click();
        await settle();
      });
      expect(
        Array.from(notFound.querySelectorAll("a")).map((link) =>
          link.getAttribute("href"),
        ),
      ).toEqual([
        "https://example.test/kimi-code",
        "https://example.test/cursor",
      ]);
      expect(
        harness.dom.window.document.querySelectorAll('[data-agent="codex"]')
          .length,
      ).toBe(1);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("a limited agent shows its main restriction with all of them on request and can be turned on; an agent with its own ACP command is ready without an adapter", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const found = (agent: string, version: string): AgentSetupDto => ({
      ...deferredSetup(agent, true),
      verdict: { state: "supported" },
      canSignIn: true,
      cli: { ...deferredSetup(agent, true).cli, version },
      cliRange: { minimum: version, testedUpTo: version },
      cliVersion: { state: "supported" },
    });
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex"),
        agentSetup("claude-code"),
        {
          ...found("pi", "1.0.0"),
          verdict: {
            state: "limited",
            restrictions: ["no_permission_requests", "turn_errors_hidden"],
          },
        },
        found("opencode", "2.0.22"),
      ],
    );
    try {
      const pi = agentRow(harness.dom, "pi");
      expect(stateOf(pi)).toBe(
        "The agent runs its tools without asking for permission · All restrictions",
      );
      expect(switchOf(pi).disabled).toBe(false);
      expect(switchOf(pi).getAttribute("aria-checked")).toBe("true");
      await act(async () => {
        within(pi, "All restrictions").click();
        await settle();
      });
      const items = Array.from(
        harness.dom.window.document.querySelectorAll(
          "[data-slot=popover-content] li",
        ),
      ).map((item) => item.textContent);
      expect(items).toEqual([
        "The agent runs its tools without asking for permission",
        "A provider error ends the turn without a message",
      ]);

      const opencode = agentRow(harness.dom, "opencode");
      expect(stateOf(opencode)).toBe("Ready");
      expect(switchOf(opencode).disabled).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("turning on an agent that needs its adapter asks first and shows the install and its failure in the row; with nothing to install or remove the switch acts at once", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    let rejectInstall: (error: unknown) => void = () => {};
    const enabled: string[] = [];
    const disabled: string[] = [];
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex", {
          enabled: false,
          adapter: {
            ...agentSetup("codex").adapter!,
            install: { state: "not_installed" },
          },
        }),
        agentSetup("claude-code", { enabled: false }),
      ],
      {
        agent_setup_enable: ({ agent }) => {
          enabled.push(String(agent));
          if (agent === "codex")
            return new Promise((_, reject) => {
              rejectInstall = reject;
            });
          return agentSetup("claude-code");
        },
        agent_setup_disable: ({ agent }) => {
          disabled.push(String(agent));
          return agentSetup("claude-code", { enabled: false });
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      const codex = agentRow(harness.dom, "codex");
      expect(stateOf(codex)).toBe(
        "Adapter not installed: turning the agent on installs it",
      );
      await act(async () => {
        switchOf(codex).click();
        await settle();
      });
      const dialog = document.querySelector<HTMLElement>(
        '[role="alertdialog"]',
      )!;
      expect((dialog.textContent ?? "").includes("Turn on Codex?")).toBe(true);
      expect(
        (dialog.textContent ?? "").includes(
          "@agentclientprotocol/codex-acp 2.1.1",
        ),
      ).toBe(true);
      expect(enabled).toEqual([]);
      await act(async () => {
        within(dialog, "Turn on").click();
        await settle();
      });
      expect(enabled).toEqual(["codex"]);
      expect(stateOf(agentRow(harness.dom, "codex"))).toBe(
        "Installing the adapter…",
      );
      await act(async () => {
        rejectInstall({
          kind: "agent_adapter",
          code: "node_missing",
          required: 20,
          message: "Node.js 20 or newer was not found",
        });
        await settle();
      });
      const failed = agentRow(harness.dom, "codex");
      expect(stateOf(failed)).toBe(
        "Adapter not installed: Node.js 20 or newer was not found",
      );
      expect(within(failed, "Retry") !== undefined).toBe(true);
      expect(switchOf(failed).getAttribute("aria-checked")).toBe("false");

      // An installed adapter needs no confirmation either way.
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(enabled).toEqual(["codex", "claude-code"]);
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe("Ready");
      // Claude Code has its Svode plugin: turning it off asks, and by
      // default removes nothing.
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      const off = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
      expect(
        (off.textContent ?? "").includes("Also remove the Svode plugin"),
      ).toBe(true);
      await act(async () => {
        within(off, "Turn off").click();
        await settle();
      });
      expect(disabled).toEqual(["claude-code"]);
      expect(harness.removed).toEqual([]);
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe("Off");
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Check shows its result in the row and a failed start offers Retry", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const checks: unknown[] = [
      {
        state: "ready",
        agent: {
          name: "@agentclientprotocol/codex-acp",
          version: "2.1.1",
          capabilities: {
            loadSession: true,
            listSessions: true,
            resumeSession: true,
            closeSession: true,
          },
        },
      },
      { state: "failed_to_start", message: "initialize timed out" },
      { state: "failed_to_start", message: "initialize timed out" },
    ];
    const checked: string[] = [];
    const harness = await renderSection(
      () => status,
      () => {},
      undefined,
      {
        agent_runtime_check: ({ agent }) => {
          checked.push(String(agent));
          return checks.shift();
        },
      },
    );
    try {
      await chooseMenuItem(harness.dom, "codex", "Check");
      expect(checked).toEqual(["codex"]);
      expect(stateOf(agentRow(harness.dom, "codex"))).toBe(
        "Check passed · @agentclientprotocol/codex-acp 2.1.1",
      );
      // Other rows keep their own state.
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe("Ready");

      await chooseMenuItem(harness.dom, "codex", "Check");
      const codex = agentRow(harness.dom, "codex");
      expect(stateOf(codex)).toBe("Could not start: initialize timed out");
      await act(async () => {
        within(codex, "Retry").click();
        await settle();
      });
      expect(checked).toEqual(["codex", "codex", "codex"]);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("opening Providers reads the facts only: no agent starts and nothing is installed", async () => {
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex", {
          enabled: false,
          adapter: {
            ...agentSetup("codex").adapter!,
            install: { state: "not_installed" },
          },
        }),
        agentSetup("claude-code"),
        deferredSetup("hermes", true),
      ],
    );
    try {
      expect(harness.commands.includes("agent_setup_list")).toBe(true);
      expect(
        harness.commands.filter((command) =>
          /^agent_runtime|^agent_setup_(?!list)|^mcp_(install|remove)|^terminal_/.test(
            command,
          ),
        ),
      ).toEqual([]);
      expect(harness.commands.includes("agent_list_available")).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  test("Russian rows: sign-in, removing the adapter with a confirmation and a failed sign-in terminal", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const removed: string[] = [];
    const harness = await renderSection(
      () => status,
      () => {},
      [
        agentSetup("codex"),
        agentSetup("claude-code", {
          cli: {
            ...agentSetup("claude-code").cli,
            status: "unauthenticated",
            authenticated: false,
          },
        }),
        deferredSetup("hermes", true),
        deferredSetup("cursor", false),
      ],
      {
        agent_setup_remove_adapter: ({ agent }) => {
          removed.push(String(agent));
          return agentSetup("codex", {
            enabled: false,
            adapter: {
              ...agentSetup("codex").adapter!,
              install: { state: "not_installed" },
            },
          });
        },
        agent_setup_sign_in: () => {
          throw { kind: "agent_cli_not_found", message: "claude" };
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      expect(stateOf(agentRow(harness.dom, "codex"))).toBe("Готов");
      expect(stateOf(agentRow(harness.dom, "hermes"))).toBe(
        "Пока не поддерживается",
      );
      const notFound = document.querySelector<HTMLElement>(
        "[data-agents-not-found]",
      )!;
      expect(summary(notFound).includes("Не найдены (1)")).toBe(true);

      const claude = agentRow(harness.dom, "claude-code");
      expect(stateOf(claude)).toBe("Нужен вход");
      await act(async () => {
        within(claude, "Войти").click();
        await settle();
      });
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe(
        "Терминал входа не открылся: claude",
      );

      await chooseMenuItem(harness.dom, "codex", "Удалить адаптер");
      const dialog = document.querySelector<HTMLElement>(
        '[role="alertdialog"]',
      )!;
      expect(
        (dialog.textContent ?? "").includes("Удалить адаптер Codex?"),
      ).toBe(true);
      expect(
        (dialog.textContent ?? "").includes(
          "Вход, настройки и сессии Codex и работа в его терминале не меняются",
        ),
      ).toBe(true);
      expect(removed).toEqual([]);
      await act(async () => {
        within(dialog, "Удалить адаптер").click();
        await settle();
      });
      expect(removed).toEqual(["codex"]);
      expect(stateOf(agentRow(harness.dom, "codex"))).toBe(
        "Адаптер не установлен: включение агента установит его",
      );
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Sign in opens the agent's sign-in terminal and reads the facts again when it exits and closes", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    let signedIn = false;
    const signInCalls: string[] = [];
    const signedOut = agentSetup("claude-code", {
      cli: {
        ...agentSetup("claude-code").cli,
        status: "unauthenticated",
        authenticated: false,
      },
    });
    const harness = await renderSection(
      () => status,
      () => {},
      undefined,
      {
        agent_setup_list: () => [
          agentSetup("codex"),
          signedIn ? agentSetup("claude-code") : signedOut,
        ],
        agent_setup_sign_in: ({ agent }) => {
          signInCalls.push(String(agent));
          return {
            ptyId: "pty-sign-in",
            cwd: "/Users/test",
            shell: "/bin/zsh",
            cols: 120,
            rows: 30,
          };
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe(
        "Sign-in required",
      );
      await act(async () => {
        within(agentRow(harness.dom, "claude-code"), "Sign in").click();
        await settle();
      });
      expect(signInCalls).toEqual(["claude-code"]);
      const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
      expect(
        (dialog.textContent ?? "").includes("Sign in to Claude Code"),
      ).toBe(true);
      expect(
        dialog.querySelector('[data-terminal="pty-sign-in"]') === null,
      ).toBe(false);

      signedIn = true;
      await act(async () => {
        signInTerminals.exit?.("pty-sign-in");
        await settle();
      });
      expect(stateOf(agentRow(harness.dom, "claude-code"))).toBe("Ready");

      await act(async () => {
        within(dialog, "Done").click();
        await settle();
      });
      expect(signInTerminals.closed.includes("pty-sign-in")).toBe(true);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Add ACP agent… checks the command before it is saved, and the custom agent's row checks and removes it while Svode tools leave it out", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    let customAgents: CustomAgentSetupDto[] = [];
    const calls: Array<[string, Record<string, unknown>]> = [];
    const declared = (all: boolean) => ({
      loadSession: true,
      listSessions: all,
      resumeSession: all,
      closeSession: false,
    });
    const status = providersStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(
      () => status,
      () => {},
      undefined,
      {
        agent_custom_list: () => customAgents,
        agent_custom_check: (args) => {
          calls.push(["check", args]);
          return {
            state: "ready",
            agent: {
              name: "scripted",
              version: "1.0.0",
              capabilities: declared(false),
            },
          };
        },
        agent_custom_add: (args) => {
          calls.push(["add", args]);
          customAgents = [
            customSetup(
              "custom-my-acp-agent",
              args.definition as CustomAgentDefinitionDto,
            ),
          ];
          return customAgents[0];
        },
        agent_custom_set_enabled: (args) => {
          calls.push(["set_enabled", args]);
          customAgents = customAgents.map((agent) => ({
            ...agent,
            enabled: Boolean(args.enabled),
          }));
          return customAgents[0];
        },
        agent_runtime_check: (args) => {
          calls.push(["runtime_check", args]);
          return {
            state: "ready",
            agent: {
              name: "hermes-agent",
              version: "unknown",
              capabilities: declared(true),
            },
          };
        },
        agent_custom_remove: (args) => {
          calls.push(["remove", args]);
          customAgents = [];
          return null;
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      const [agents, integration] = topSections(harness.dom);
      // Opening the page starts no custom agent.
      expect(harness.commands.includes("agent_custom_list")).toBe(true);
      expect(
        harness.commands.some((command) =>
          ["agent_custom_check", "agent_runtime_check"].includes(command),
        ),
      ).toBe(false);

      await act(async () => {
        within(agents, "Add ACP agent…").click();
        await settle();
      });
      const form = document.querySelector<HTMLElement>(
        "[data-custom-agent-form]",
      )!;
      expect(form.querySelector("h2")?.textContent).toBe("Add ACP agent");
      expect(
        (form.textContent ?? "").includes(
          "Not for secrets: the agent gets keys and tokens from the login shell environment or its own configuration.",
        ),
      ).toBe(true);

      await act(async () => {
        within(form, "Add").click();
        await settle();
      });
      expect((form.textContent ?? "").includes("Enter a name")).toBe(true);

      setFieldValue(field(form, "custom-agent-name"), "My ACP agent");
      setFieldValue(field(form, "custom-agent-command"), "hermes");
      setFieldValue(field(form, "custom-agent-args"), "acp\n");
      setFieldValue(field(form, "custom-agent-env"), "not a variable");
      await act(async () => {
        within(form, "Check").click();
        await settle();
      });
      expect(
        (form.textContent ?? "").includes(
          "Not a NAME=value line: not a variable",
        ),
      ).toBe(true);
      expect(calls.length).toBe(0);

      setFieldValue(field(form, "custom-agent-env"), "HERMES_MODE=acp");
      await act(async () => {
        within(form, "Check").click();
        await settle();
      });
      const definition = {
        name: "My ACP agent",
        command: "hermes",
        args: ["acp"],
        env: { HERMES_MODE: "acp" },
      };
      expect(calls).toEqual([["check", { agent: null, definition }]]);
      expect(form.querySelector("[data-custom-agent-check]")?.textContent).toBe(
        "Check passed · scripted 1.0.0 · new sessions only",
      );

      await act(async () => {
        within(form, "Add").click();
        await settle();
      });
      expect(calls[1]).toEqual(["add", { definition }]);
      expect(document.querySelector("[data-custom-agent-form]")).toBeNull();
      const row = () => agentRow(harness.dom, "custom-my-acp-agent");
      expect(title(row())).toBe("My ACP agent");
      expect(stateOf(row())).toBe("Ready");

      // Turning a custom agent off and on installs and asks nothing.
      await act(async () => {
        switchOf(row()).click();
        await settle();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(calls[2]).toEqual([
        "set_enabled",
        { agent: "custom-my-acp-agent", enabled: false },
      ]);
      expect(stateOf(row())).toBe("Off");
      await act(async () => {
        switchOf(row()).click();
        await settle();
      });
      expect(stateOf(row())).toBe("Ready");

      await chooseMenuItem(harness.dom, "custom-my-acp-agent", "Check");
      expect(calls.at(-1)).toEqual([
        "runtime_check",
        { agent: "custom-my-acp-agent" },
      ]);
      expect(stateOf(row())).toBe(
        "Check passed · hermes-agent unknown · declares session list, history, resume",
      );

      // Svode installs no tools for a custom agent.
      await act(async () => {
        within(integration, "Manage…").click();
        await settle();
      });
      const tools = document.querySelector<HTMLElement>("[data-svode-tools]")!;
      expect(toolsAgents(tools).map(([agent]) => agent)).toEqual([
        "codex",
        "claude-code",
      ]);
      expect((tools.textContent ?? "").includes("My ACP agent")).toBe(false);
      await act(async () => {
        within(tools, "Cancel").click();
        await settle();
      });

      await chooseMenuItem(harness.dom, "custom-my-acp-agent", "Remove");
      const removal = document.querySelector<HTMLElement>(
        "[data-custom-agent-remove]",
      )!;
      expect(removal.querySelector("h2")?.textContent).toBe(
        "Remove My ACP agent?",
      );
      expect(
        (removal.textContent ?? "").includes(
          "The agent's sessions, sign-in and settings stay as they are.",
        ),
      ).toBe(true);
      await act(async () => {
        within(removal, "Remove").click();
        await settle();
      });
      expect(calls.at(-1)).toEqual([
        "remove",
        { agent: "custom-my-acp-agent" },
      ]);
      expect(
        document.querySelector('[data-agent="custom-my-acp-agent"]'),
      ).toBeNull();
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian: a custom agent row shows a missing command and the new-session-only restriction, and editing keeps its id and shows a rejected variable at its field", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const definition = {
      name: "Hermes ACP",
      command: "hermes",
      args: ["acp"],
      env: { HERMES_MODE: "acp" },
    };
    let customAgents = [
      customSetup("custom-hermes-acp", definition, {
        restriction: "new_session_only",
      }),
      customSetup(
        "custom-missing",
        { ...definition, name: "Missing", command: "no-such-agent" },
        { executablePath: null },
      ),
    ];
    const updates: Record<string, unknown>[] = [];
    const harness = await renderSection(
      () => providersStatus([client("codex", "Codex", false)]),
      () => {},
      undefined,
      {
        agent_custom_list: () => customAgents,
        agent_custom_update: (args) => {
          updates.push(args);
          if (updates.length === 1)
            throw {
              kind: "custom_agent",
              code: "invalid_variable",
              name: "1KEY",
              message: "1KEY is not a valid environment variable name",
            };
          const next = customSetup(
            String(args.agent),
            args.definition as CustomAgentDefinitionDto,
            { restriction: "new_session_only" },
          );
          customAgents = [next, customAgents[1]];
          return next;
        },
      },
    );
    try {
      const document = harness.dom.window.document;
      const limited = agentRow(harness.dom, "custom-hermes-acp");
      expect(stateOf(limited)).toBe(
        "Только новые сессии: агент не объявил список или загрузку сессий",
      );
      const missing = agentRow(harness.dom, "custom-missing");
      expect(stateOf(missing)).toBe("Команда не найдена: no-such-agent");
      expect(
        missing
          .querySelector("[data-agent-state]")
          ?.classList.contains("text-destructive"),
      ).toBe(true);
      expect(within(missing, "Повторить") === undefined).toBe(true);

      await chooseMenuItem(harness.dom, "custom-hermes-acp", "Изменить…");
      const form = document.querySelector<HTMLElement>(
        "[data-custom-agent-form]",
      )!;
      expect(form.querySelector("h2")?.textContent).toBe("Изменить ACP-агента");
      expect(field(form, "custom-agent-name").value).toBe("Hermes ACP");
      expect(field(form, "custom-agent-args").value).toBe("acp");
      expect(field(form, "custom-agent-env").value).toBe("HERMES_MODE=acp");

      setFieldValue(field(form, "custom-agent-name"), "Hermes");
      await act(async () => {
        within(form, "Сохранить").click();
        await settle();
      });
      expect(
        (form.textContent ?? "").includes("Строка не вида NAME=значение: 1KEY"),
      ).toBe(true);
      expect(document.querySelector("[data-custom-agent-form]") === null).toBe(
        false,
      );

      await act(async () => {
        within(form, "Сохранить").click();
        await settle();
      });
      expect(updates[1]).toEqual({
        agent: "custom-hermes-acp",
        definition: { ...definition, name: "Hermes" },
      });
      expect(document.querySelector("[data-custom-agent-form]")).toBeNull();
      expect(title(agentRow(harness.dom, "custom-hermes-acp"))).toBe("Hermes");
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });
}

const IDENTITIES = [
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
  { id: "hermes", displayName: "Hermes" },
  { id: "kimi-code", displayName: "Kimi Code" },
  { id: "cursor", displayName: "Cursor" },
  { id: "opencode", displayName: "opencode" },
  { id: "grok-build", displayName: "Grok Build" },
];

function agentSetup(
  agent: string,
  overrides: Partial<AgentSetupDto> = {},
): AgentSetupDto {
  const adapterPackage =
    agent === "codex"
      ? "@agentclientprotocol/codex-acp"
      : "@agentclientprotocol/claude-agent-acp";
  return {
    agent,
    enabled: true,
    verdict: { state: "supported" },
    installHint: `https://example.test/${agent}`,
    canSignIn: true,
    cli: {
      adapter: agent,
      status: "ready",
      executablePath: `/Users/test/.bun/bin/${agent}`,
      version:
        agent === "codex" ? "codex-cli 0.159.3" : "2.1.287 (Claude Code)",
      authenticated: true,
      code: null,
      message: null,
    },
    cliRange:
      agent === "codex"
        ? { minimum: "0.159.1", testedUpTo: "0.159.3" }
        : { minimum: "2.1.286", testedUpTo: "2.1.287" },
    cliVersion: { state: "supported" },
    adapter: {
      package: adapterPackage,
      pinnedVersion: agent === "codex" ? "2.1.1" : "0.85.0",
      install: {
        state: "installed",
        version: agent === "codex" ? "2.1.1" : "0.85.0",
      },
      requiredNodeMajor: agent === "codex" ? 20 : 22,
      node: { state: "ready", path: "/usr/local/bin/node", version: "22.23.1" },
    },
    ...overrides,
  };
}

function customSetup(
  agent: string,
  definition: CustomAgentDefinitionDto,
  overrides: Partial<CustomAgentSetupDto> = {},
): CustomAgentSetupDto {
  return {
    agent,
    ...definition,
    enabled: true,
    executablePath: `/usr/local/bin/${definition.command}`,
    declared: null,
    restriction: null,
    ...overrides,
  };
}

function field(container: HTMLElement, id: string) {
  return container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `#${id}`,
  )!;
}

function setFieldValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const window = input.ownerDocument.defaultView!;
  const prototype =
    input.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  // React watches value changes of the focused field in this DOM.
  act(() => {
    input.focus();
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
      input,
      value,
    );
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    const propertyChange = new window.Event("propertychange", {
      bubbles: true,
    });
    Object.defineProperty(propertyChange, "propertyName", { value: "value" });
    input.dispatchEvent(propertyChange);
  });
}

function deferredSetup(agent: string, found: boolean): AgentSetupDto {
  return {
    agent,
    enabled: true,
    verdict: { state: "deferred" },
    installHint: `https://example.test/${agent}`,
    canSignIn: false,
    cli: {
      adapter: agent,
      status: found ? "unknown" : "missing",
      executablePath: found ? `/usr/local/bin/${agent}` : null,
      version: found ? "0.18.2" : null,
      authenticated: null,
      code: found ? "auth_status_unavailable" : "adapter_missing",
      message: null,
    },
    cliRange: null,
    cliVersion: { state: "unknown" },
    adapter: null,
  };
}

type Handler = (args: Record<string, unknown>) => unknown;

// A handler that returns undefined lets the canonical mock answer.
async function renderSection(
  getCanonical: () => McpStatus,
  setCanonical: (status: McpStatus) => void,
  setups: AgentSetupDto[] = [agentSetup("codex"), agentSetup("claude-code")],
  handlers: Record<string, Handler> = {},
) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const installed: string[] = [];
  const removed: string[] = [];
  const commands: string[] = [];
  mockNativeIpc(
    (command, args) => {
      commands.push(command);
      const values = (args ?? {}) as Record<string, unknown>;
      const handled = handlers[command]?.(values);
      if (handled !== undefined) return handled;
      if (command === "agent_adapters_list_identities") return IDENTITIES;
      if (command === "agent_setup_list") return setups;
      if (command === "agent_custom_list") return [];
      if (command === "mcp_get_status") return getCanonical();
      if (command === "mcp_run_doctor") return getCanonical().doctor;
      if (command === "mcp_install_client" || command === "mcp_remove_client") {
        const id = String(values.client);
        const install = command === "mcp_install_client";
        (install ? installed : removed).push(id);
        const next = withClients(
          getCanonical(),
          getCanonical().clients.map((candidate) =>
            candidate.id === id
              ? client(candidate.id, candidate.name, install)
              : candidate,
          ),
        );
        setCanonical(next);
        return next;
      }
      if (command === "mcp_remove_shared_skill") {
        const current = getCanonical();
        if (current.sharedSkill.requiredBy.length)
          throw { kind: "general", message: "the shared skill is needed" };
        removed.push("#shared");
        const next = {
          ...current,
          sharedSkill: { ...current.sharedSkill, state: "absent" as const },
        };
        setCanonical(next);
        return next;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);
  await act(async () => {
    root.render(<ProvidersSection />);
    await settle();
  });
  return {
    dom,
    installed,
    removed,
    commands,
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
  };
}

function providersStatus(clients: McpClientStatus[]): McpStatus {
  return withClients(
    {
      server: {
        status: "installed",
        command: "/Users/test/.svode/bin/svode-mcp",
        version: "0.0.9",
        runtime: { kind: "desktop", version: "0.0.9" },
      },
      clients: [],
      sharedSkill: {
        path: "/Users/test/.agents/skills/svode",
        state: "absent",
        readers: clients.some((candidate) => candidate.id === "codex")
          ? ["codex"]
          : [],
        requiredBy: [],
      },
      manualConfig: {
        name: "svode",
        transport: "stdio",
        command: "/Users/test/.svode/bin/svode-mcp",
        args: [],
        env: {},
      },
      doctor: {
        ok: true,
        messages: ["ready"],
        errors: [],
        bridgeCompatible: true,
      },
    },
    clients,
  );
}

// Codex needs the shared skill: connecting it installs the skill, while
// removing its own part keeps it.
function withClients(status: McpStatus, clients: McpClientStatus[]): McpStatus {
  const requiredBy = clients
    .filter((candidate) => candidate.id === "codex" && candidate.installed)
    .map((candidate) => candidate.id);
  return {
    ...status,
    clients,
    sharedSkill: {
      ...status.sharedSkill,
      state: requiredBy.length ? "managed" : status.sharedSkill.state,
      requiredBy,
    },
  };
}

function client(
  id: McpClientStatus["id"],
  name: string,
  installed: boolean,
  overrides: Partial<McpClientStatus> = {},
): McpClientStatus {
  const state = installed ? "managed" : "absent";
  const configPath =
    id === "codex"
      ? "/Users/test/.codex/config.toml"
      : "/Users/test/.claude.json";
  return {
    id,
    name,
    found: true,
    installed,
    managed: installed,
    status: installed ? "installed" : "mcp_not_installed",
    path: `/Users/test/.bun/bin/${id}`,
    configPath,
    complete: installed,
    version: installed ? "0.0.9" : null,
    issues: [],
    ownPart:
      id === "codex"
        ? { kind: "mcp-entry", path: configPath, state }
        : { kind: "plugin", path: "/Users/test/.claude/skills/svode", state },
    limitation: null,
    ...overrides,
  };
}

// Top-level sections of the page: agents, Svode integration and runtime.
function topSections(dom: JSDOM) {
  return Array.from(
    dom.window.document.querySelectorAll<HTMLElement>("section"),
  ).filter((section) => !section.parentElement?.closest("section"));
}

// Title and description of each row of the integration block.
function partRows(integration: HTMLElement) {
  return Array.from(integration.querySelectorAll('[data-slot="item"]')).map(
    (item) => [
      item.querySelector('[data-slot="item-title"]')?.textContent ?? "",
      item.querySelector('[data-slot="item-description"]')?.textContent ?? "",
    ],
  );
}

// Agent, name, kit and state, checked and whether it can be changed.
function toolsAgents(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("[data-tools-agent]"),
  ).map((field) => {
    const box = field.querySelector<HTMLButtonElement>(
      'button[role="checkbox"]',
    )!;
    return [
      field.dataset.toolsAgent ?? "",
      field.querySelector('[data-slot="field-label"]')?.textContent ?? "",
      field.querySelector('[data-slot="field-description"]')?.textContent ?? "",
      box.getAttribute("aria-checked") ?? "",
      box.disabled ? "disabled" : "enabled",
    ];
  });
}

function checkboxOf(dialog: HTMLElement, agent: string) {
  return dialog.querySelector<HTMLButtonElement>(
    `[data-tools-agent="${agent}"] button[role="checkbox"]`,
  )!;
}

function summaryLines(dialog: HTMLElement) {
  const summary = dialog.querySelector("[data-tools-summary]")!;
  const lines = Array.from(summary.querySelectorAll("li"));
  return lines.length
    ? lines.map((line) => line.textContent ?? "")
    : [summary.querySelector("p")?.textContent ?? ""];
}

function results(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("li[data-tools-result]"),
  ).map((line) => [line.dataset.toolsResult ?? "", line.textContent ?? ""]);
}

// Options of a confirmation with whether each is checked.
function checkboxes(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("[data-confirmation-option]"),
  ).map((option) => [
    option.querySelector('[data-slot="field-label"]')?.textContent ?? "",
    option
      .querySelector('button[role="checkbox"]')
      ?.getAttribute("aria-checked") ?? "",
  ]);
}

// The always visible part of a row.
function summary(row: HTMLElement) {
  return row.querySelector('[data-slot="item-content"]')?.textContent ?? "";
}

function agentRow(dom: JSDOM, agent: string) {
  return dom.window.document.querySelector<HTMLElement>(
    `[data-agent="${agent}"]`,
  )!;
}

function title(row: HTMLElement) {
  return row.querySelector('[data-slot="item-title"]')?.textContent ?? "";
}

function stateOf(row: HTMLElement) {
  return row.querySelector("[data-agent-state]")?.textContent ?? "";
}

function switchOf(row: HTMLElement) {
  return row.querySelector<HTMLButtonElement>('button[role="switch"]')!;
}

async function chooseMenuItem(dom: JSDOM, agent: string, name: string) {
  const trigger = agentRow(dom, agent).querySelector<HTMLButtonElement>(
    '[aria-label^="More actions"], [aria-label^="Другие действия"]',
  )!;
  await act(async () => {
    trigger.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      }),
    );
    await settle();
  });
  const item = Array.from(
    dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).find((candidate) => candidate.textContent?.trim() === name)!;
  await act(async () => {
    item.click();
    await settle();
  });
}

function within(row: HTMLElement, name: string) {
  return Array.from(row.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement;
}

function findButton(dom: JSDOM, name: string) {
  return Array.from(dom.window.document.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === name,
  ) as HTMLButtonElement;
}

function createDom() {
  return new JSDOM(
    "<!doctype html><html lang=en><body><div id=app></div></body></html>",
    { pretendToBeVisual: true, url: "http://localhost/" },
  );
}

function installDomGlobals(dom: JSDOM) {
  // React watches the focused field through these in this DOM.
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.addEventListener(name.replace(/^on/, ""), listener);
      },
    },
    detachEvent: {
      configurable: true,
      value(this: HTMLElement, name: string, listener: EventListener) {
        this.removeEventListener(name.replace(/^on/, ""), listener);
      },
    },
  });
  const values: Record<string, unknown> = {
    CustomEvent: dom.window.CustomEvent,
    DOMRect: dom.window.DOMRect,
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
    PointerEvent: dom.window.PointerEvent,
    ResizeObserver: class {
      disconnect() {}
      observe() {}
      unobserve() {}
    },
    document: dom.window.document,
    getComputedStyle: dom.window.getComputedStyle,
    navigator: dom.window.navigator,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    window: dom.window,
  };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value,
      writable: true,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  };
}

async function settle() {
  await nextTurn();
  await nextTurn();
  await nextTurn();
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
