import { expect, test } from "bun:test";
import {
  attachTerminalView,
  clearTerminalOutput,
  publishTerminalOutput,
  type TerminalOutputView,
} from "./output-bus";

/** A view that processes writes only when the test lets it, as xterm does. */
function deferredView() {
  const shown: string[] = [];
  const pending: Array<() => void> = [];
  const view: TerminalOutputView = {
    write(data, onProcessed) {
      pending.push(() => {
        shown.push(data);
        onProcessed?.();
      });
    },
  };
  const processAll = () => {
    while (pending.length > 0) pending.shift()?.();
  };
  return { view, shown, processAll };
}

function immediateView(shown: string[]): TerminalOutputView {
  return {
    write(data, onProcessed) {
      shown.push(data);
      onProcessed?.();
    },
  };
}

test("replays terminal output to later views", () => {
  const ptyId = "replay-later";
  const first: string[] = [];
  const second: string[] = [];

  publishTerminalOutput(ptyId, "hello");
  publishTerminalOutput(ptyId, " world");

  const firstView = attachTerminalView(ptyId, immediateView(first));
  expect(first.join("")).toBe("hello world");

  publishTerminalOutput(ptyId, "\nnext");
  firstView.detach();

  const secondView = attachTerminalView(ptyId, immediateView(second));
  expect(second.join("")).toBe("hello world\nnext");

  secondView.detach();
  clearTerminalOutput(ptyId);
});

test("a view accepts input only after its replay is processed", () => {
  const ptyId = "replay-input";
  publishTerminalOutput(ptyId, "\x1b[c");
  publishTerminalOutput(ptyId, "\x1b[6n\x1b]11;?\x07");

  const { view, shown, processAll } = deferredView();
  const attachment = attachTerminalView(ptyId, view);
  expect(attachment.acceptsInput()).toBe(false);

  // Live output queued behind the replay stays live.
  publishTerminalOutput(ptyId, "live");
  processAll();

  expect(shown).toEqual(["\x1b[c", "\x1b[6n\x1b]11;?\x07", "live"]);
  expect(attachment.acceptsInput()).toBe(true);

  attachment.detach();
  clearTerminalOutput(ptyId);
});

test("a view of a PTY without past output accepts input at once", () => {
  const ptyId = "no-replay";
  const attachment = attachTerminalView(ptyId, deferredView().view);

  expect(attachment.acceptsInput()).toBe(true);

  attachment.detach();
  clearTerminalOutput(ptyId);
});

test("only the last attached view of a PTY accepts input", () => {
  const ptyId = "two-views";
  publishTerminalOutput(ptyId, "prompt");
  const leaving: string[] = [];
  const arriving: string[] = [];

  const leavingView = attachTerminalView(ptyId, immediateView(leaving));
  const arrivingView = attachTerminalView(ptyId, immediateView(arriving));
  publishTerminalOutput(ptyId, "\x1b[c");

  expect(leaving).toEqual(["prompt", "\x1b[c"]);
  expect(arriving).toEqual(["prompt", "\x1b[c"]);
  expect(leavingView.acceptsInput()).toBe(false);
  expect(arrivingView.acceptsInput()).toBe(true);

  // The remaining view takes the input back when the last one leaves.
  arrivingView.detach();
  expect(leavingView.acceptsInput()).toBe(true);

  leavingView.detach();
  clearTerminalOutput(ptyId);
});

test("clearTerminalOutput removes replay and ignores later output", () => {
  const ptyId = "clear-replay";
  const received: string[] = [];

  publishTerminalOutput(ptyId, "before");
  clearTerminalOutput(ptyId);
  publishTerminalOutput(ptyId, "after");

  const attachment = attachTerminalView(ptyId, immediateView(received));

  expect(received).toEqual([]);
  expect(attachment.acceptsInput()).toBe(false);
  attachment.detach();
});
