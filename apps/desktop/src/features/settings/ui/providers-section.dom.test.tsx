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

import type { AgentSetupDto, McpClientStatus, McpStatus } from "../api";
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

  test("a connected row shows the version, its details and keeps focus through disconnect", async () => {
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
      const row = clientRow(harness.dom, "codex");
      expect(row.textContent?.includes("Connected · Svode 0.0.9")).toBe(true);
      expect(/restart|Details/.test(summary(row))).toBe(false);
      expect(
        row.textContent?.includes("/Users/test/.agents/skills/svode"),
      ).toBe(false);
      expect(
        Array.from(harness.dom.window.document.querySelectorAll("h2, h3")).map(
          (heading) => heading.textContent,
        ),
      ).toEqual(["Svode access", "Svode runtime"]);

      await act(async () => {
        within(row, "Details").click();
        await settle();
      });
      const details = row.textContent ?? "";
      // The agent CLI is a fact of the agent row, not of Svode access.
      expect(details.includes("/Users/test/.bun/bin/codex")).toBe(false);
      expect(details.includes("/Users/test/.agents/skills/svode")).toBe(true);
      // The runtime and its check belong to the section, not to one agent.
      expect(
        /svode-mcp|\(Svode Desktop\)|Connection check|Run check/.test(details),
      ).toBe(false);
      expect(harness.dom.window.document.querySelector("textarea")).toBeNull();
      await act(async () => {
        within(row, "Show").click();
        await settle();
      });
      expect(row.querySelector("textarea")?.textContent).toBe(
        "[mcp_servers.svode]",
      );
      expect(harness.printed).toEqual(["codex"]);

      const toggle = row.querySelector<HTMLButtonElement>(
        'button[role="switch"]',
      )!;
      expect(toggle.getAttribute("aria-label")).toBe("Svode access for Codex");
      toggle.focus();
      await act(async () => {
        toggle.click();
        await settle();
      });
      expect(
        summary(clientRow(harness.dom, "codex")).includes("Not connected"),
      ).toBe(true);
      expect(harness.dom.window.document.activeElement).toBe(toggle);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("the section shows the agents without a heading, Svode access below them and the runtime with its check once", async () => {
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
      const [agents, access, runtime] = Array.from(
        document.querySelectorAll<HTMLElement>("section"),
      ).filter((section) => !section.parentElement?.closest("section"));
      expect(agents.querySelector("h2, h3, h4")).toBeNull();
      expect(
        agents.textContent?.includes(
          "Use the agents found on this device in Svode chat and sessions",
        ),
      ).toBe(true);
      expect(within(agents, "Refresh") !== undefined).toBe(true);
      expect(agents.querySelectorAll("[data-agent]").length).toBe(2);
      expect(agents.querySelectorAll("[data-mcp-client]").length).toBe(0);
      expect(access.hasAttribute("data-svode-access")).toBe(true);
      expect(access.querySelector("h3")?.textContent).toBe("Svode access");
      expect(
        access.textContent?.includes(
          "Svode access connects the Svode skill, the svode command and the Svode MCP server to the agent.",
        ),
      ).toBe(true);
      expect(access.querySelectorAll("[data-mcp-client]").length).toBe(2);

      expect(runtime.hasAttribute("data-mcp-runtime")).toBe(true);
      expect(runtime.querySelector("h3")?.textContent).toBe("Svode runtime");
      const runtimeText = runtime.textContent ?? "";
      expect(runtimeText.includes("Active runtime")).toBe(true);
      expect(runtimeText.includes("/Users/test/.svode/bin/svode-mcp")).toBe(
        true,
      );
      expect(runtimeText.includes("0.0.9 (Svode Desktop)")).toBe(true);
      expect(runtimeText.includes("Ready")).toBe(true);

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
      expect(
        (runtime.textContent ?? "").includes("bridge is not running"),
      ).toBe(false);
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

  test("details list the artifacts of the way each agent is connected", async () => {
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
      const claude = clientRow(harness.dom, "claude-code");
      const codex = clientRow(harness.dom, "codex");
      await act(async () => {
        within(claude, "Details").click();
        within(codex, "Details").click();
        await settle();
      });
      expect(artifactRows(claude)).toEqual([
        [
          "Plugin",
          "/Users/test/.claude/skills/svode",
          "The Svode skill, MCP server and svode command for the agent in one plugin",
          "Svode",
        ],
      ]);
      expect(
        /Not set up|MCP entry|\.claude\.json/.test(claude.textContent ?? ""),
      ).toBe(false);
      expect(artifactRows(codex)).toEqual([
        [
          "Skill",
          "/Users/test/.agents/skills/svode",
          "Shared agent skill that teaches the agent to work with Svode",
          "Svode",
        ],
        [
          "MCP entry",
          "/Users/test/.codex/config.toml",
          "Starts the Svode MCP server for the agent",
          "Svode",
        ],
      ]);
      expect((codex.textContent ?? "").includes("Not set up")).toBe(false);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian details show an extra Claude entry with its own state", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    const connected = client("claude-code", "Claude Code", true);
    let canonical = providersStatus([
      {
        ...connected,
        attentionCode: "incomplete",
        status: "attention",
        complete: false,
        artifacts: [
          ...(connected.artifacts ?? []),
          {
            kind: "mcp-entry",
            path: "/Users/test/.claude.json",
            state: "previous",
          },
        ],
      },
      client("codex", "Codex", false),
    ]);
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const claude = clientRow(harness.dom, "claude-code");
      const codex = clientRow(harness.dom, "codex");
      await act(async () => {
        within(claude, "Подробнее").click();
        within(codex, "Подробнее").click();
        await settle();
      });
      expect(artifactRows(claude)).toEqual([
        [
          "Plugin",
          "/Users/test/.claude/skills/svode",
          "Skill Svode, MCP-сервер и команда svode для агента в одном plugin",
          "Svode",
        ],
        [
          "Запись MCP",
          "/Users/test/.claude.json",
          "Не нужна: MCP-сервер Svode уже приходит из plugin",
          "Прежний Svode Desktop",
        ],
      ]);
      expect(
        /svode-mcp|\(Svode Desktop\)|Проверка подключения|Запустить проверку/.test(
          claude.textContent ?? "",
        ),
      ).toBe(false);
      // A client that is not connected shows its missing artifacts as absent.
      expect(artifactRows(codex).map((row) => [row[0], row[3]])).toEqual([
        ["Skill", "Нет"],
        ["Запись MCP", "Нет"],
      ]);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian custom conflict has one localized attention state and a disabled switch", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    let canonical = providersStatus([
      client("claude-code", "Claude Code", false),
      {
        ...client("codex", "Codex", false),
        attentionCode: "custom_conflict",
        status: "attention",
      },
    ]);
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const text = summary(clientRow(harness.dom, "codex"));
      expect(
        clientRow(harness.dom, "codex").textContent?.includes(
          "Требует внимания",
        ),
      ).toBe(true);
      expect(text.includes("настроена вручную")).toBe(true);
      expect(/connected|needs attention|custom conflict/i.test(text)).toBe(
        false,
      );
      expect(
        clientRow(harness.dom, "codex").querySelector<HTMLButtonElement>(
          'button[role="switch"]',
        )?.disabled,
      ).toBe(true);

      const refresh = findButton(harness.dom, "Обновить");
      refresh.focus();
      await act(async () => {
        refresh.click();
        await settle();
      });
      expect(harness.dom.window.document.activeElement).toBe(refresh);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("an update of this start asks to restart open sessions and a missing client cannot connect", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    let canonical: McpStatus = {
      ...providersStatus([
        client("claude-code", "Claude Code", true),
        {
          ...client("codex", "Codex", false),
          found: false,
          status: "not_found",
        },
      ]),
      runtimeUpdatedFrom: "0.0.8",
    };
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const claude = summary(clientRow(harness.dom, "claude-code"));
      expect(
        claude.includes(
          "Updated to Svode 0.0.9. Agent sessions that are already open get it after a restart.",
        ),
      ).toBe(true);
      const codex = clientRow(harness.dom, "codex");
      expect(summary(codex).includes("Not found on this device")).toBe(true);
      expect(
        codex.querySelector<HTMLButtonElement>('button[role="switch"]')
          ?.disabled,
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("an unavailable runtime is explained once and a connected client can still disconnect", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    const status = providersStatus([
      {
        ...client("claude-code", "Claude Code", true),
        attentionCode: "runtime_unavailable",
        status: "attention",
        version: null,
      },
      client("codex", "Codex", false),
    ]);
    let canonical: McpStatus = {
      ...status,
      runtimeUpdatedFrom: "0.0.8",
      server: {
        status: "not_found",
        command: "/Users/test/.svode/bin/svode-mcp",
      },
    };
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      const document = harness.dom.window.document;
      const callout = document.querySelector(
        '[data-slot="alert"][class*="destructive"]',
      );
      expect(
        callout?.textContent?.includes("Svode runtime is unavailable"),
      ).toBe(true);
      const runtime =
        document.querySelector<HTMLElement>("[data-mcp-runtime]")!;
      expect(runtime.textContent?.includes("Unavailable")).toBe(true);
      expect(runtime.textContent?.includes("0.0.9")).toBe(false);
      const claude = clientRow(harness.dom, "claude-code");
      expect(summary(claude).includes("does not start")).toBe(false);
      expect(summary(claude).includes("Connected")).toBe(true);
      expect(summary(claude).includes("Updated to")).toBe(false);
      expect(summary(claude).includes("—")).toBe(false);
      expect(
        claude.querySelector<HTMLButtonElement>('button[role="switch"]')
          ?.disabled,
      ).toBe(false);
      expect(
        clientRow(harness.dom, "codex").querySelector<HTMLButtonElement>(
          'button[role="switch"]',
        )?.disabled,
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("a runtime that speaks another bridge protocol is reported in Svode access", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    let canonical: McpStatus = {
      ...providersStatus([
        client("claude-code", "Claude Code", true),
        client("codex", "Codex", false),
      ]),
      doctor: {
        ok: false,
        messages: [],
        errors: ["svode-mcp of the runtime speaks bridge protocol a, not b"],
        bridgeCompatible: false,
      },
    };
    const harness = await renderSection(
      () => canonical,
      (next) => {
        canonical = next;
      },
    );
    try {
      expect(
        harness.dom.window.document.body.textContent?.includes(
          "Несовместимая версия bridge",
        ),
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
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
        deferredSetup("gemini-cli", false),
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
        "https://example.test/gemini-cli",
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

  test("turning on an agent that needs its adapter asks first and shows the install and its failure in the row; otherwise the switch acts at once", async () => {
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
      await act(async () => {
        switchOf(agentRow(harness.dom, "claude-code")).click();
        await settle();
      });
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      expect(disabled).toEqual(["claude-code"]);
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
}

const IDENTITIES = [
  { id: "codex", displayName: "Codex" },
  { id: "claude-code", displayName: "Claude Code" },
  { id: "hermes", displayName: "Hermes" },
  { id: "gemini-cli", displayName: "Gemini CLI" },
  { id: "cursor", displayName: "Cursor" },
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

async function renderSection(
  getCanonical: () => McpStatus,
  setCanonical: (status: McpStatus) => void,
  setups: AgentSetupDto[] = [agentSetup("codex"), agentSetup("claude-code")],
  handlers: Record<string, Handler> = {},
) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const printed: string[] = [];
  const commands: string[] = [];
  mockNativeIpc(
    (command, args) => {
      commands.push(command);
      const handler = handlers[command];
      if (handler) return handler((args ?? {}) as Record<string, unknown>);
      if (command === "agent_adapters_list_identities") return IDENTITIES;
      if (command === "agent_setup_list") return setups;
      if (command === "mcp_get_status") return getCanonical();
      if (command === "mcp_run_doctor") return getCanonical().doctor;
      if (command === "mcp_print_config") {
        const id = String((args as Record<string, unknown>).client);
        printed.push(id);
        return id === "codex" ? "[mcp_servers.svode]" : "claude mcp add";
      }
      if (command === "mcp_install_client" || command === "mcp_remove_client") {
        const id = String((args as Record<string, unknown>).client);
        const installed = command === "mcp_install_client";
        const next = {
          ...getCanonical(),
          clients: getCanonical().clients.map((candidate) =>
            candidate.id === id
              ? client(candidate.id, candidate.name, installed)
              : candidate,
          ),
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
    printed,
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
  return {
    server: {
      status: "installed",
      command: "/Users/test/.svode/bin/svode-mcp",
      version: "0.0.9",
      runtime: { kind: "desktop", version: "0.0.9" },
    },
    clients,
    doctor: {
      ok: true,
      messages: ["ready"],
      errors: [],
      bridgeCompatible: true,
    },
  };
}

function client(
  id: McpClientStatus["id"],
  name: string,
  installed: boolean,
): McpClientStatus {
  const state = installed ? "managed" : "absent";
  return {
    id,
    name,
    found: true,
    installed,
    managed: installed,
    status: installed ? "installed" : "mcp_not_installed",
    path: `/Users/test/.bun/bin/${id}`,
    configPath:
      id === "codex"
        ? "/Users/test/.codex/config.toml"
        : "/Users/test/.claude.json",
    complete: installed,
    version: installed ? "0.0.9" : null,
    artifacts:
      id === "codex"
        ? [
            { kind: "skill", path: "/Users/test/.agents/skills/svode", state },
            {
              kind: "mcp-entry",
              path: "/Users/test/.codex/config.toml",
              state,
            },
          ]
        : [{ kind: "plugin", path: "/Users/test/.claude/skills/svode", state }],
  };
}

// The always visible part of a row, without its details.
function summary(row: HTMLElement) {
  return row.querySelector('[data-slot="item-content"]')?.textContent ?? "";
}

// Title, path, purpose and state of each artifact in the open details.
function artifactRows(row: HTMLElement) {
  return Array.from(row.querySelectorAll("[data-mcp-artifact]")).map((item) => [
    item.querySelector('[data-slot="item-title"]')?.textContent ?? "",
    ...Array.from(
      item.querySelectorAll('[data-slot="item-description"] > span'),
    ).map((span) => span.textContent ?? ""),
    item.querySelector('[data-slot="item-actions"]')?.textContent ?? "",
  ]);
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

function clientRow(dom: JSDOM, id: McpClientStatus["id"]) {
  return dom.window.document.querySelector<HTMLElement>(
    `[data-mcp-client="${id}"]`,
  )!;
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
