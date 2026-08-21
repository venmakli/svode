import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";

import {
  type McpClientStatus,
  type McpStatus,
  useMcpIntegrations,
} from "./use-mcp-integrations";

const MCP_STATUS_CHANGED_EVENT = "mcp:status-changed";

test("converges mounted MCP surfaces, deduplicates equal snapshots, and cleans up", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let canonical = mcpStatus(false, false, "initial");
  let reads = 0;
  const renders = new Map<string, number>();
  mockNativeIpc(
    (command, args) => {
      if (command === "mcp_get_status") {
        reads += 1;
        return canonical;
      }
      if (command === "mcp_install_client") {
        const client = String((args as Record<string, unknown>).client);
        canonical = mcpStatus(
          client === "codex" || codexInstalled(canonical),
          client === "claude-code" || claudeInstalled(canonical),
          canonical.doctor.messages[0] ?? "initial",
        );
        window.setTimeout(() => {
          void emitNativeEvent(MCP_STATUS_CHANGED_EVENT);
        }, 0);
        return canonical;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(
        <>
          <McpHarness id="first" renders={renders} />
          <McpHarness id="second" renders={renders} />
        </>,
      );
      await settle();
    });
    expect(clientState(dom, "first", "codex")).toBe("off");
    expect(clientState(dom, "second", "codex")).toBe("off");

    await act(async () => {
      click(dom, "first", "install-codex");
      await settle();
    });
    expect(clientState(dom, "first", "codex")).toBe("on");
    expect(clientState(dom, "second", "codex")).toBe("on");

    await act(async () => {
      root.render(
        <>
          <McpHarness id="first" renders={renders} />
          <McpHarness id="second" renders={renders} />
          <McpHarness id="third" renders={renders} />
        </>,
      );
      await settle();
    });
    expect(clientState(dom, "third", "codex")).toBe("on");

    canonical = mcpStatus(false, false, "external");
    await act(async () => {
      dom.window.dispatchEvent(new dom.window.Event("focus"));
      await settle();
    });
    expect(clientState(dom, "first", "codex")).toBe("off");
    expect(clientState(dom, "second", "codex")).toBe("off");
    expect(doctorState(dom, "first")).toBe("initial");
    expect(doctorState(dom, "second")).toBe("initial");

    canonical = mcpStatus(true, false, "manual refresh");
    await act(async () => {
      click(dom, "first", "refresh");
      await settle();
    });
    expect(clientState(dom, "first", "codex")).toBe("on");
    expect(clientState(dom, "second", "codex")).toBe("off");
    expect(doctorState(dom, "first")).toBe("manual refresh");
    expect(doctorState(dom, "second")).toBe("initial");

    await act(async () => {
      await emitNativeEvent(MCP_STATUS_CHANGED_EVENT);
      await settle();
    });
    expect(clientState(dom, "second", "codex")).toBe("on");
    expect(doctorState(dom, "second")).toBe("initial");

    const rendersBeforeEqualEvent = new Map(renders);
    await act(async () => {
      await emitNativeEvent(MCP_STATUS_CHANGED_EVENT);
      await settle();
    });
    expect(renders).toEqual(rendersBeforeEqualEvent);

    await act(async () => {
      root.unmount();
      await settle();
    });
    const readsBeforeCleanup = reads;
    dom.window.dispatchEvent(new dom.window.Event("focus"));
    await settle();
    expect(reads).toBe(readsBeforeCleanup);
  } finally {
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("keeps per-client pending isolated and ignores a late toggle result", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  let canonical = mcpStatus(false, false);
  const lateInstall = deferred<McpStatus>();
  mockNativeIpc(
    (command, args) => {
      if (command === "mcp_get_status") return canonical;
      if (
        command === "mcp_install_client" &&
        (args as Record<string, unknown>).client === "codex"
      ) {
        return lateInstall.promise;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<McpHarness id="only" />);
      await settle();
    });

    await act(async () => {
      click(dom, "only", "install-codex");
      await nextTurn();
    });
    expect(pendingState(dom, "only", "codex")).toBe("pending");
    expect(pendingState(dom, "only", "claude-code")).toBe("idle");

    await act(async () => {
      canonical = mcpStatus(false, false);
      await emitNativeEvent(MCP_STATUS_CHANGED_EVENT);
      await settle();
      lateInstall.resolve(mcpStatus(true, false));
      await settle();
    });

    expect(clientState(dom, "only", "codex")).toBe("off");
    expect(pendingState(dom, "only", "codex")).toBe("idle");
  } finally {
    await act(async () => root.unmount());
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

test("re-reads canonical MCP status after a failed client mutation", async () => {
  const dom = createDom();
  const restoreGlobals = installDomGlobals(dom);
  const canonical = mcpStatus(false, false);
  let reads = 0;
  const previousConsoleError = console.error;
  console.error = () => {};
  mockNativeIpc(
    (command) => {
      if (command === "mcp_get_status") {
        reads += 1;
        return canonical;
      }
      if (command === "mcp_install_client") {
        throw new Error("client config write failed");
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    { shouldMockEvents: true },
  );
  const root = createRoot(dom.window.document.getElementById("app")!);

  try {
    await act(async () => {
      root.render(<McpHarness id="only" />);
      await settle();
    });
    const readsBeforeMutation = reads;

    await act(async () => {
      click(dom, "only", "install-codex");
      await settle();
    });

    expect(reads > readsBeforeMutation).toBe(true);
    expect(clientState(dom, "only", "codex")).toBe("off");
    expect(pendingState(dom, "only", "codex")).toBe("idle");
  } finally {
    await act(async () => root.unmount());
    console.error = previousConsoleError;
    clearNativeMocks();
    restoreGlobals();
    dom.window.close();
  }
});

function McpHarness({
  id,
  renders,
}: {
  id: string;
  renders?: Map<string, number>;
}) {
  const settings = useMcpIntegrations();
  renders?.set(id, (renders.get(id) ?? 0) + 1);
  const codex = settings.status?.clients.find(
    (client) => client.id === "codex",
  );
  const claude = settings.status?.clients.find(
    (client) => client.id === "claude-code",
  );

  return (
    <div data-harness={id}>
      <span data-client="codex">{codex?.installed ? "on" : "off"}</span>
      <span data-client="claude-code">{claude?.installed ? "on" : "off"}</span>
      <span data-pending="codex">
        {settings.pendingClients.has("codex") ? "pending" : "idle"}
      </span>
      <span data-pending="claude-code">
        {settings.pendingClients.has("claude-code") ? "pending" : "idle"}
      </span>
      <span data-doctor>{settings.doctor?.messages[0] ?? "none"}</span>
      <button
        data-action="install-codex"
        onClick={() => codex && settings.handleToggle(codex, true)}
      />
      <button data-action="refresh" onClick={settings.loadStatus} />
    </div>
  );
}

function mcpStatus(
  codex: boolean,
  claude: boolean,
  doctorMessage = "ready",
): McpStatus {
  return {
    server: { status: "installed", command: "/Applications/Svode/svode-mcp" },
    clients: [
      client("claude-code", "Claude Code", claude),
      client("codex", "Codex", codex),
    ],
    manualConfig: {
      name: "svode",
      transport: "stdio",
      command: "/Applications/Svode/svode-mcp",
      args: ["--app", "desktop"],
      env: {},
    },
    doctor: { ok: true, messages: [doctorMessage], errors: [] },
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
    status: installed ? "installed" : "mcp_not_installed",
  };
}

function codexInstalled(status: McpStatus) {
  return Boolean(
    status.clients.find((client) => client.id === "codex")?.installed,
  );
}

function claudeInstalled(status: McpStatus) {
  return Boolean(
    status.clients.find((client) => client.id === "claude-code")?.installed,
  );
}

function clientState(dom: JSDOM, harness: string, clientId: string) {
  return dom.window.document.querySelector(
    `[data-harness="${harness}"] [data-client="${clientId}"]`,
  )?.textContent;
}

function pendingState(dom: JSDOM, harness: string, clientId: string) {
  return dom.window.document.querySelector(
    `[data-harness="${harness}"] [data-pending="${clientId}"]`,
  )?.textContent;
}

function doctorState(dom: JSDOM, harness: string) {
  return dom.window.document.querySelector(
    `[data-harness="${harness}"] [data-doctor]`,
  )?.textContent;
}

function click(dom: JSDOM, harness: string, action: string) {
  dom.window.document
    .querySelector<HTMLButtonElement>(
      `[data-harness="${harness}"] [data-action="${action}"]`,
    )!
    .click();
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
    Node: dom.window.Node,
    document: dom.window.document,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function settle() {
  await nextTurn();
  await nextTurn();
  await nextTurn();
}

function nextTurn() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
