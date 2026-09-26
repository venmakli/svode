import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { McpClientStatus, McpStatus } from "../api";
import type { AvailableAgent } from "../model";
import { ProvidersSection } from "./providers-section";

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
      ).toEqual(["Agents"]);

      await act(async () => {
        within(row, "Details").click();
        await settle();
      });
      const details = row.textContent ?? "";
      expect(details.includes("/Users/test/.bun/bin/codex")).toBe(true);
      expect(details.includes("codex-cli 0.155.1 · authorized")).toBe(true);
      expect(details.includes("/Users/test/.agents/skills/svode")).toBe(true);
      expect(
        details.includes("Integration 0.0.9 · runtime 0.0.9 (Svode Desktop)"),
      ).toBe(true);
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

  test("an update of this start asks to restart open sessions, a missing agent offers its install", async () => {
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
      [agent("claude", "2.1.282 (Claude Code)", "unauthorized"), missingCodex],
    );
    try {
      const claude = summary(clientRow(harness.dom, "claude-code"));
      expect(
        claude.includes(
          "Updated to Svode 0.0.9. Agent sessions that are already open get it after a restart.",
        ),
      ).toBe(true);
      expect(claude.includes("Run `claude login` in terminal")).toBe(true);
      const codex = clientRow(harness.dom, "codex");
      expect(summary(codex).includes("Not found on this device")).toBe(true);
      expect(
        codex.querySelector('a[href="https://example.test/codex"]') !== null,
      ).toBe(true);
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
      },
      client("codex", "Codex", false),
    ]);
    let canonical: McpStatus = {
      ...status,
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
      const claude = clientRow(harness.dom, "claude-code");
      expect(summary(claude).includes("does not start")).toBe(false);
      expect(summary(claude).includes("Connected · Svode 0.0.9")).toBe(true);
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

  test("a runtime that speaks another bridge protocol is reported above the agents", async () => {
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
}

const missingCodex: AvailableAgent = {
  name: "codex",
  path: "",
  version: null,
  authStatus: "not_found",
  docsUrl: "https://example.test/codex",
};

function agent(
  name: string,
  version: string,
  authStatus: string,
): AvailableAgent {
  return {
    name,
    path: `/Users/test/.bun/bin/${name}`,
    version,
    authStatus,
    docsUrl: `https://example.test/${name}`,
  };
}

async function renderSection(
  getCanonical: () => McpStatus,
  setCanonical: (status: McpStatus) => void,
  agents: AvailableAgent[] = [
    agent("claude", "2.1.282 (Claude Code)", "authorized"),
    agent("codex", "codex-cli 0.155.1", "authorized"),
  ],
) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const printed: string[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command === "mcp_get_status") return getCanonical();
      if (command === "mcp_run_doctor") return getCanonical().doctor;
      if (command === "agent_list_available") return agents;
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
  const skill =
    id === "codex"
      ? "/Users/test/.agents/skills/svode"
      : "/Users/test/.claude/skills/svode";
  return {
    id,
    name,
    found: true,
    installed,
    managed: installed,
    status: installed ? "installed" : "mcp_not_installed",
    path: `/Users/test/.bun/bin/${id}`,
    configPath: "/Users/test/.codex/config.toml",
    complete: installed,
    version: installed ? "0.0.9" : null,
    artifacts: [
      { kind: "skill", path: skill, state: installed ? "managed" : "absent" },
      {
        kind: "mcp-entry",
        path: "/Users/test/.codex/config.toml",
        state: installed && id === "codex" ? "managed" : "absent",
      },
    ],
  };
}

// The always visible part of a row, without its details.
function summary(row: HTMLElement) {
  return row.querySelector('[data-slot="item-content"]')?.textContent ?? "";
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
    Element: dom.window.Element,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    MouseEvent: dom.window.MouseEvent,
    Node: dom.window.Node,
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
