import { expect, test } from "bun:test";
import { activitySnapshot } from "../../model/testing/activity";
import { composerKeyAction, reconcileUnknownSend } from "./composer";
import { canOpenChatDraft, defaultChatAgent, draftAgent } from "./agents";

const key = (
  init: Partial<Pick<KeyboardEvent, "key" | "shiftKey" | "isComposing" | "keyCode">>,
) => ({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, ...init });

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

test("a draft starts with the last chat agent while available, else the first available", () => {
  const agents = {
    agents: [
      { agent: "codex", name: "Codex", offer: available },
      { agent: "claude-code", name: "Claude Code", offer: available },
      { agent: "pi", name: "pi", offer: outdated },
    ],
    last: "claude-code",
  };
  expect(defaultChatAgent(agents)).toBe("claude-code");
  expect(defaultChatAgent({ ...agents, last: "pi" })).toBe("codex");
  expect(draftAgent(agents, "pi")).toBe("pi");
  expect(draftAgent(agents, "gone")).toBe("claude-code");
  expect(canOpenChatDraft(agents)).toBe(true);
  expect(
    canOpenChatDraft({
      agents: [{ agent: "pi", name: "pi", offer: outdated }],
      last: null,
    }),
  ).toBe(false);
});

test("an agent that needs sign-in opens a draft and is chosen only without an available one", () => {
  const signIn = { state: "sign_in_required" } as const;
  const onlySignIn = {
    agents: [
      { agent: "pi", name: "pi", offer: outdated },
      { agent: "claude-code", name: "Claude Code", offer: signIn },
    ],
    last: null,
  };
  expect(canOpenChatDraft(onlySignIn)).toBe(true);
  expect(defaultChatAgent(onlySignIn)).toBe("claude-code");
  expect(
    defaultChatAgent({
      agents: [
        { agent: "claude-code", name: "Claude Code", offer: signIn },
        { agent: "codex", name: "Codex", offer: available },
      ],
      last: "claude-code",
    }),
  ).toBe("codex");
});

test("a turn duration reads in seconds, minutes and hours", async () => {
  const { setLocale } = await import("@/paraglide/runtime");
  const { formatDuration } = await import("./format");
  setLocale("en", { reload: false });
  expect(formatDuration(4_200)).toBe("4s");
  expect(formatDuration(62_000)).toBe("1m 2s");
  expect(formatDuration(3_720_000)).toBe("1h 2m");
});
