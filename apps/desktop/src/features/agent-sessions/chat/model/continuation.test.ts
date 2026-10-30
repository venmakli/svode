import { expect, test } from "bun:test";
import { listedSession } from "../../model/testing/catalog";
import { primaryContinuation } from "./continuation";
import { openInChatAvailability } from "./interface";

const available = { available: true } as const;

test("before a choice the primary action is the other interface of the pair", () => {
  expect(
    primaryContinuation({
      shownIn: "chat",
      rememberedTerminal: null,
      chat: available,
      svodeTerminal: available,
    }),
  ).toEqual({ kind: "svode_terminal", availability: available });
  expect(
    primaryContinuation({
      shownIn: "terminal",
      rememberedTerminal: null,
      chat: available,
      svodeTerminal: available,
    }),
  ).toEqual({ kind: "chat", availability: available });
});

test("a remembered external terminal is primary in the chat and in the terminal", () => {
  for (const shownIn of ["chat", "terminal"] as const) {
    expect(
      primaryContinuation({
        shownIn,
        rememberedTerminal: "iterm2",
        chat: available,
        svodeTerminal: available,
      }),
    ).toEqual({ kind: "external_terminal", appId: "iterm2" });
  }
});

test("an unavailable pair action stays primary with its reason", () => {
  expect(
    primaryContinuation({
      shownIn: "chat",
      rememberedTerminal: null,
      chat: available,
      svodeTerminal: { available: false, reason: "turn_active" },
    }),
  ).toEqual({
    kind: "svode_terminal",
    availability: { available: false, reason: "turn_active" },
  });
  expect(
    primaryContinuation({
      shownIn: "terminal",
      rememberedTerminal: null,
      chat: { available: false, reason: "not_openable" },
      svodeTerminal: available,
    }),
  ).toEqual({
    kind: "chat",
    availability: { available: false, reason: "not_openable" },
  });
});

test("the chat of a session in its terminal is available unless the runtime cannot open it", () => {
  // A live Svode terminal no longer keeps the chat away: the chat closes it.
  expect(
    openInChatAvailability(
      listedSession({
        id: "codex:abc",
        runtime: { live: true, ptyId: "pty-1" },
        capabilities: { canResume: true, canOpenInChat: true },
      }),
    ),
  ).toEqual(available);
  expect(
    openInChatAvailability(
      listedSession({
        id: "codex:plain",
        capabilities: { canResume: true, canOpenInChat: false },
      }),
    ),
  ).toEqual({ available: false, reason: "not_openable" });
  expect(
    openInChatAvailability(
      listedSession({
        id: "cursor:ide",
        capabilities: {
          canResume: false,
          canOpenInChat: false,
          continuesInIde: true,
        },
      }),
    ),
  ).toEqual({ available: false, reason: "continues_in_ide" });
});
