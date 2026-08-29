import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { getLocale, setLocale } from "@/paraglide/runtime.js";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import type { McpClientStatus, McpStatus } from "../api";
import { McpIntegrationsSection } from "./mcp-section";

const isolatedProcess = process.env.SVODE_MCP_SECTION_DOM_PROCESS === "1";

if (!isolatedProcess) {
  test("MCP Settings connected and attention DOM scenarios", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: {
          ...process.env,
          SVODE_MCP_SECTION_DOM_PROCESS: "1",
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
  test("connected rows stay build-neutral and preserve focus through disconnect", async () => {
    const originalLocale = getLocale();
    await setLocale("en", { reload: false });
    let canonical = mcpStatus([
      client("claude-code", "Claude Code", true),
      client("codex", "Codex", true),
    ]);
    const harness = await renderSection(() => canonical, (next) => {
      canonical = next;
    });
    try {
      const row = clientRow(harness.dom, "codex");
      expect(row.textContent?.includes("connected")).toBe(true);
      expect(row.textContent?.includes("/Applications/Svode Dev")).toBe(false);
      expect(
        /version|session|update|restart/i.test(row.textContent ?? ""),
      ).toBe(false);
      expect(row.className.includes("min-w-0")).toBe(true);
      expect(row.className.includes("overflow-hidden")).toBe(true);

      const toggle = row.querySelector<HTMLButtonElement>(
        'button[role="switch"]',
      )!;
      toggle.focus();
      expect(harness.dom.window.document.activeElement).toBe(toggle);
      await act(async () => {
        toggle.click();
        await settle();
      });

      expect(clientRow(harness.dom, "codex").textContent?.includes("not connected")).toBe(
        true,
      );
      expect(harness.dom.window.document.activeElement).toBe(toggle);
      expect(
        harness.dom.window.document
          .querySelector("textarea")
          ?.textContent?.includes("SVODE_MCP_MANAGED"),
      ).toBe(true);
    } finally {
      await harness.cleanup();
      await setLocale(originalLocale, { reload: false });
    }
  });

  test("Russian custom conflict has one localized attention state and no path ceremony", async () => {
    const originalLocale = getLocale();
    await setLocale("ru", { reload: false });
    let canonical = mcpStatus([
      client("claude-code", "Claude Code", false),
      {
        ...client("codex", "Codex", false),
        attentionCode: "custom_conflict",
        status: "attention",
      },
    ]);
    const harness = await renderSection(() => canonical, (next) => {
      canonical = next;
    });
    try {
      const row = clientRow(harness.dom, "codex");
      const text = row.textContent ?? "";
      expect(text.includes("требует внимания")).toBe(true);
      expect(text.includes("настроена вручную")).toBe(true);
      expect(text.includes("/Applications/Svode Dev")).toBe(false);
      expect(/connected|needs attention|custom conflict/i.test(text)).toBe(
        false,
      );
      expect(
        row.querySelector<HTMLButtonElement>('button[role="switch"]')
          ?.disabled,
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
}

async function renderSection(
  getCanonical: () => McpStatus,
  setCanonical: (status: McpStatus) => void,
) {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  mockNativeIpc(
    (command, args) => {
      if (command === "mcp_get_status") return getCanonical();
      if (command === "mcp_run_doctor") return getCanonical().doctor;
      if (
        command === "mcp_install_client" ||
        command === "mcp_remove_client"
      ) {
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
    root.render(<McpIntegrationsSection />);
    await settle();
  });
  return {
    dom,
    cleanup: async () => {
      await act(async () => root.unmount());
      clearNativeMocks();
      restoreGlobals();
      dom.window.close();
    },
  };
}

function mcpStatus(clients: McpClientStatus[]): McpStatus {
  return {
    server: {
      status: "installed",
      command: "/Applications/Svode Dev.app/Contents/Resources/svode-mcp",
      version: "0.0.7-dev",
    },
    clients,
    manualConfig: {
      name: "svode",
      transport: "stdio",
      command: "/Applications/Svode Dev.app/Contents/Resources/svode-mcp",
      args: ["--app", "desktop"],
      env: { SVODE_MCP_MANAGED: "svode-desktop-bridge-v1" },
    },
    doctor: { ok: true, messages: ["ready"], errors: [] },
  };
}

function client(
  id: McpClientStatus["id"],
  name: string,
  installed: boolean,
): McpClientStatus {
  return {
    id,
    name,
    found: true,
    installed,
    managed: installed,
    status: installed ? "installed" : "mcp_not_installed",
    path: "/Applications/Svode Dev.app/Contents/MacOS/client",
    configPath: "/Users/test/.config/client",
  };
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
