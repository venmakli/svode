import { expect, test } from "bun:test";
import { activitySnapshot } from "../../model/testing/activity";
import { composerKeyAction, reconcileUnknownSend } from "./composer";
import {
  canOpenChatDraft,
  defaultAgentValues,
  defaultChatAgent,
  draftAgent,
} from "./agents";

const key = (
  init: Partial<
    Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">
  >,
) => ({
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
  ...init,
});

test("Enter sends, Shift+Enter breaks the line and Enter during IME only commits", () => {
  expect(composerKeyAction(key({}), false)).toBe("send");
  expect(composerKeyAction(key({ shiftKey: true }), false)).toBe("soft_break");
  expect(composerKeyAction(key({ isComposing: true }), false)).toBeNull();
  expect(composerKeyAction(key({ keyCode: 229 }), false)).toBeNull();
  expect(composerKeyAction(key({ key: "a" }), false)).toBeNull();
});

test("Esc stops a running turn and does nothing without one", () => {
  expect(composerKeyAction(key({ key: "Escape" }), true)).toBe("stop");
  expect(composerKeyAction(key({ key: "Escape" }), false)).toBeNull();
});

test("an unknown send counts as sent only when a new turn appeared", () => {
  const turn = (turnId: string | null) =>
    activitySnapshot({
      turn: { ...activitySnapshot().turn, turnId },
    });
  expect(reconcileUnknownSend("t1", turn("t2"))).toBe("accepted");
  expect(reconcileUnknownSend("t1", turn("t1"))).toBe("not_sent");
  expect(reconcileUnknownSend(null, turn(null))).toBe("not_sent");
});

const available = { state: "available" } as const;
const outdated = {
  state: "unavailable",
  reason: { code: "adapter_needs_update", installedVersion: "0.1.0" },
} as const;

test("a draft starts with the default agent while the chat offers it, else the first available", () => {
  const agents = {
    unoffered: [],
    agents: [
      { agent: "codex", name: "Codex", offer: available },
      { agent: "claude-code", name: "Claude Code", offer: available },
      { agent: "pi", name: "pi", offer: outdated },
    ],
  };
  expect(defaultChatAgent(agents, "claude-code")).toBe("claude-code");
  expect(defaultChatAgent(agents, "pi")).toBe("codex");
  expect(defaultChatAgent(agents, "gone")).toBe("codex");
  expect(defaultChatAgent(agents, null)).toBe("codex");
  expect(draftAgent(agents, "pi", "claude-code")).toBe("pi");
  expect(draftAgent(agents, "gone", "claude-code")).toBe("claude-code");
  expect(draftAgent(agents, null, null)).toBe("codex");
  expect(canOpenChatDraft(agents)).toBe(true);
  expect(
    canOpenChatDraft({
      unoffered: [],
      agents: [{ agent: "pi", name: "pi", offer: outdated }],
    }),
  ).toBe(false);
});

test("an agent that needs sign-in opens a draft, is chosen without an available one and as the default agent", () => {
  const signIn = { state: "sign_in_required" } as const;
  const onlySignIn = {
    unoffered: [],
    agents: [
      { agent: "pi", name: "pi", offer: outdated },
      { agent: "claude-code", name: "Claude Code", offer: signIn },
    ],
  };
  expect(canOpenChatDraft(onlySignIn)).toBe(true);
  expect(defaultChatAgent(onlySignIn, null)).toBe("claude-code");
  const both = {
    unoffered: [],
    agents: [
      { agent: "claude-code", name: "Claude Code", offer: signIn },
      { agent: "codex", name: "Codex", offer: available },
    ],
  };
  expect(defaultChatAgent(both, null)).toBe("codex");
  expect(defaultChatAgent(both, "claude-code")).toBe("claude-code");
});

test("a new draft takes the values of the default agent only for that agent", () => {
  const defaultAgent = {
    agent: "codex",
    settings: [
      { setting: "model", value: "gpt-6.1-sol" },
      { setting: "mode", value: "agent" },
    ],
  };
  expect(defaultAgentValues(defaultAgent, "codex")).toEqual(
    defaultAgent.settings,
  );
  expect(defaultAgentValues(defaultAgent, "claude-code")).toEqual([]);
  expect(defaultAgentValues(null, "codex")).toEqual([]);
  expect(defaultAgentValues(defaultAgent, null)).toEqual([]);
});

test("a turn duration reads in seconds, minutes and hours", async () => {
  const { setLocale } = await import("@/paraglide/runtime");
  const { formatDuration } = await import("./format");
  setLocale("en", { reload: false });
  expect(formatDuration(4_200)).toBe("4s");
  expect(formatDuration(62_000)).toBe("1m 2s");
  expect(formatDuration(3_720_000)).toBe("1h 2m");
});
