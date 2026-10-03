import { expect, test } from "bun:test";
import type { AgentSetupDto } from "../api";
import {
  agentFound,
  agentOperationError,
  agentRowView,
  cliVersionLabel,
  enableBlocked,
  enableInstallsAdapter,
} from "./agent-row";

function setup(overrides: Partial<AgentSetupDto> = {}): AgentSetupDto {
  return {
    agent: "codex",
    enabled: true,
    verdict: { state: "supported" },
    installHint: "https://example.test/codex",
    canSignIn: true,
    cli: {
      adapter: "codex",
      status: "ready",
      executablePath: "/bin/codex",
      version: "codex-cli 0.159.3",
      authenticated: true,
      code: null,
      message: null,
    },
    cliRange: { minimum: "0.159.1", testedUpTo: "0.159.3" },
    cliVersion: { state: "supported" },
    adapter: {
      package: "@agentclientprotocol/codex-acp",
      pinnedVersion: "2.1.1",
      install: { state: "installed", version: "2.1.1" },
      requiredNodeMajor: 20,
      node: { state: "ready", path: "/bin/node", version: "22.23.1" },
    },
    ...overrides,
  };
}

const signedOut = {
  ...setup().cli,
  status: "unauthenticated" as const,
  authenticated: false,
};
const noNode = {
  ...setup().adapter!,
  node: { state: "missing" as const },
};
const notInstalled = {
  ...setup().adapter!,
  install: { state: "not_installed" as const },
};
const outdated = {
  ...setup().adapter!,
  install: { state: "needs_update" as const, installedVersion: "2.1.0" },
};

test("a row shows one state in the priority of the contract", () => {
  const kind = (value: AgentSetupDto) => agentRowView(value, null).state.kind;
  const unsupported = {
    cliVersion: { state: "unsupported" as const, minimum: "0.159.1" },
  };
  // Required actions come first, in their own order.
  expect(
    kind(
      setup({
        cli: signedOut,
        adapter: notInstalled,
        enabled: false,
        ...unsupported,
      }),
    ),
  ).toBe("sign_in");
  expect(kind(setup({ adapter: noNode, ...unsupported }))).toBe("node");
  expect(kind(setup({ adapter: notInstalled, ...unsupported }))).toBe(
    "cli_unsupported",
  );
  expect(kind(setup({ adapter: notInstalled, enabled: false }))).toBe(
    "adapter_missing",
  );
  expect(kind(setup({ adapter: outdated }))).toBe("adapter_outdated");
  // Without them an enabled agent is ready and a disabled one is off.
  expect(kind(setup())).toBe("ready");
  expect(kind(setup({ enabled: false }))).toBe("disabled");
  // A deferred agent is only that, whatever else is true.
  expect(
    kind(
      setup({ verdict: { state: "deferred" }, cli: signedOut, adapter: null }),
    ),
  ).toBe("deferred");
});

test("a limited agent shows its main restriction after required actions", () => {
  const cursor = setup({
    agent: "cursor",
    verdict: {
      state: "limited",
      restrictions: ["external_sessions_unlisted", "no_terminal_continuation"],
    },
    adapter: null,
    cliVersion: { state: "untested", testedUpTo: "2026.10.1" },
  });
  const view = agentRowView(cursor, null);
  expect(view.state).toEqual({
    kind: "limited",
    restrictions: ["external_sessions_unlisted", "no_terminal_continuation"],
  });
  expect(view.warning).toEqual({ kind: "untested", testedUpTo: "2026.10.1" });
  expect(view.action).toBeNull();
  // The restriction stays when the agent is off, like a custom agent's.
  expect(agentRowView({ ...cursor, enabled: false }, null).state.kind).toBe(
    "limited",
  );
  expect(
    agentRowView({ ...cursor, cli: signedOut }, null).state.kind,
  ).toBe("sign_in");
  expect(enableBlocked(cursor)).toBe(false);
});

test("each state offers at most one contextual action", () => {
  expect(agentRowView(setup({ cli: signedOut }), null).action).toBe("sign_in");
  expect(
    agentRowView(setup({ cli: signedOut, canSignIn: false }), null).action,
  ).toBeNull();
  expect(agentRowView(setup({ adapter: outdated }), null).action).toBe(
    "update",
  );
  expect(
    agentRowView(setup({ adapter: notInstalled }), null).action,
  ).toBeNull();
  expect(agentRowView(setup(), null).action).toBeNull();
  const failed = agentRowView(setup(), {
    kind: "failed",
    operation: "install",
    error: { code: "download", message: "offline" },
  });
  expect([failed.state.kind, failed.action]).toEqual(["failed", "retry"]);
  const notStarted = agentRowView(setup(), {
    kind: "checked",
    result: { state: "failed_to_start", message: "initialize timed out" },
  });
  expect([notStarted.state.kind, notStarted.action]).toEqual([
    "failed_to_start",
    "retry",
  ]);
});

test("the latest activity of the row shows before its facts", () => {
  const value = setup({ cli: signedOut });
  expect(
    agentRowView(value, { kind: "pending", operation: "install" }).state,
  ).toEqual({ kind: "pending", operation: "install" });
  expect(
    agentRowView(value, {
      kind: "checked",
      result: {
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
    }).state,
  ).toEqual({
    kind: "checked",
    name: "@agentclientprotocol/codex-acp",
    version: "2.1.1",
    // A built-in agent is described; only a custom one shows its declaration.
    declared: null,
  });
  expect(
    agentRowView(setup(), {
      kind: "checked",
      result: { state: "auth_required", message: "login" },
    }).state.kind,
  ).toBe("sign_in");
  // A deferred agent never starts, so nothing replaces its state.
  expect(
    agentRowView(setup({ verdict: { state: "deferred" } }), {
      kind: "pending",
      operation: "check",
    }).state.kind,
  ).toBe("deferred");
});

test("a CLI newer than tested or unrecognized warns in the same line", () => {
  const untested = setup({
    cliVersion: { state: "untested", testedUpTo: "0.159.3" },
  });
  expect(agentRowView(untested, null).warning).toEqual({
    kind: "untested",
    testedUpTo: "0.159.3",
  });
  expect(
    agentRowView(setup({ cliVersion: { state: "unknown" } }), null).warning,
  ).toEqual({ kind: "unknown" });
  // Without a verified range there is nothing to warn about.
  expect(
    agentRowView(
      setup({
        verdict: { state: "deferred" },
        cliRange: null,
        cliVersion: { state: "unknown" },
      }),
      null,
    ).warning,
  ).toBeNull();
  // A required action is the line; the warning waits.
  expect(
    agentRowView({ ...untested, cli: signedOut }, null).warning,
  ).toBeNull();
});

test("found, enabling and the version fact come from the setup facts", () => {
  expect(agentFound(setup())).toBe(true);
  expect(
    agentFound(setup({ cli: { ...setup().cli, status: "missing" } })),
  ).toBe(false);
  expect(enableInstallsAdapter(setup({ adapter: notInstalled }))).toBe(true);
  expect(enableInstallsAdapter(setup({ adapter: outdated }))).toBe(false);
  expect(
    enableBlocked(setup({ adapter: { ...notInstalled, node: noNode.node } })),
  ).toBe(true);
  expect(enableBlocked(setup({ adapter: notInstalled }))).toBe(false);
  expect(enableBlocked(setup({ verdict: { state: "deferred" } }))).toBe(true);
  expect(cliVersionLabel(setup())).toBe("0.159.3");
  expect(
    cliVersionLabel(
      setup({ cli: { ...setup().cli, version: "2.1.287 (Claude Code)" } }),
    ),
  ).toBe("2.1.287");
  expect(
    cliVersionLabel(setup({ cli: { ...setup().cli, version: null } })),
  ).toBe(null);
});

test("adapter command errors keep their code and fields", () => {
  expect(
    agentOperationError({
      kind: "agent_adapter",
      code: "node_missing",
      required: 22,
      message: "Node.js 22 or newer was not found",
    }),
  ).toEqual({
    code: "node_missing",
    required: 22,
    message: "Node.js 22 or newer was not found",
  });
  expect(agentOperationError("boom")).toEqual({ code: null, message: "boom" });
});
