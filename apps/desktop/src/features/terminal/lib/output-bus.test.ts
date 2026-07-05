import { expect, test } from "bun:test";
import {
  clearTerminalOutput,
  publishTerminalOutput,
  subscribeTerminalOutput,
} from "./output-bus";

test("replays terminal output to later subscribers", () => {
  const ptyId = "replay-later";
  const first: string[] = [];
  const second: string[] = [];

  publishTerminalOutput(ptyId, "hello");
  publishTerminalOutput(ptyId, " world");

  const unsubscribeFirst = subscribeTerminalOutput(ptyId, (data) => {
    first.push(data);
  });
  expect(first.join("")).toBe("hello world");

  publishTerminalOutput(ptyId, "\nnext");
  unsubscribeFirst();

  const unsubscribeSecond = subscribeTerminalOutput(ptyId, (data) => {
    second.push(data);
  });
  expect(second.join("")).toBe("hello world\nnext");

  unsubscribeSecond();
  clearTerminalOutput(ptyId);
});

test("clearTerminalOutput removes replay and ignores later output", () => {
  const ptyId = "clear-replay";
  const received: string[] = [];

  publishTerminalOutput(ptyId, "before");
  clearTerminalOutput(ptyId);
  publishTerminalOutput(ptyId, "after");

  const unsubscribe = subscribeTerminalOutput(ptyId, (data) => {
    received.push(data);
  });

  expect(received).toEqual([]);
  unsubscribe();
});
