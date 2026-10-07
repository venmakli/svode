import { expect, test } from "bun:test";
import { listedSession } from "../../model/testing/catalog";
import {
  chatInterface,
  openInTerminalAvailability,
  sessionInterfaceAtOpen,
} from "./interface";

const key = { agent: "codex", namespace: "native", sessionId: "abc" } as const;

test("a session with a live Svode terminal opens in it", () => {
  const session = listedSession({
    id: "codex:abc",
    runtime: { live: true, ptyId: "pty-1" },
    capabilities: { canResume: true, canOpenInChat: true },
  });
  expect(sessionInterfaceAtOpen(session, "pty-1")).toEqual({
    kind: "terminal",
    chatUnavailable: null,
  });
  // A new session started in a terminal has no record yet.
  expect(sessionInterfaceAtOpen(null, "pty-new")).toEqual({
    kind: "terminal",
    chatUnavailable: null,
  });
});

test("a session the runtime drives opens in the chat that follows it", () => {
  const session = listedSession({
    id: "codex:abc",
    runtime: { live: true, acpSession: key },
    capabilities: { canResume: true, canOpenInChat: true },
  });
  expect(sessionInterfaceAtOpen(session, null)).toEqual({
    kind: "chat",
    followed: true,
  });
});

test("without a Svode writer a session opens in the chat", () => {
  const session = listedSession({
    id: "codex:abc",
    capabilities: { canResume: true, canOpenInChat: true },
  });
  expect(sessionInterfaceAtOpen(session, null)).toEqual({
    kind: "chat",
    followed: false,
  });
  // A custom agent without a terminal opens in the chat too.
  const custom = listedSession({
    id: "custom-echo:acp:abc",
    source: "custom-echo",
    capabilities: { canResume: false, canOpenInChat: true },
  });
  expect(sessionInterfaceAtOpen(custom, null)).toEqual({
    kind: "chat",
    followed: false,
  });
});

test("a session the chat cannot open stays in the terminal with the reason", () => {
  const session = listedSession({ id: "codex:abc" });
  expect(sessionInterfaceAtOpen(session, null)).toEqual({
    kind: "terminal",
    chatUnavailable: { kind: "not_openable" },
  });
  expect(chatInterface(session)).toEqual({
    kind: "terminal",
    chatUnavailable: { kind: "not_openable" },
  });
});

test("an IDE chat stays out of the chat with the IDE as the reason", () => {
  const session = listedSession({
    id: "cursor:ide:abc",
    source: "cursor",
    capabilities: {
      canResume: false,
      canOpenInChat: false,
      continuesInIde: true,
    },
  });
  expect(sessionInterfaceAtOpen(session, null)).toEqual({
    kind: "terminal",
    chatUnavailable: { kind: "continues_in_ide" },
  });
});

test("an unknown session opens in nothing until it is known", () => {
  expect(sessionInterfaceAtOpen(null, null)).toBeNull();
});

test("open in terminal waits for the turn and needs a terminal", () => {
  expect(openInTerminalAvailability(true, false)).toEqual({ available: true });
  expect(openInTerminalAvailability(true, true)).toEqual({
    available: false,
    reason: "turn_active",
  });
  expect(openInTerminalAvailability(false, false)).toEqual({
    available: false,
    reason: "no_terminal",
  });
});
