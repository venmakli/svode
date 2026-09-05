import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { prepareTextDiff } from "../api/inspection";
import { createItemReader } from "./item-reader";

const scope = {
  kind: "directory",
  path: "contract",
  spacePath: "/project",
} as const;
function readerTest(name: string, run: () => Promise<void>) {
  test(name, async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      await run();
    } finally {
      clearNativeMocks();
      if (previousWindow)
        Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
}

readerTest(
  "expanded patch reads are bounded, queued cancellation is passive and generations are checked",
  async () => {
    const pending: (() => void)[] = [];
    const paths: string[] = [];
    mockNativeIpc((command, args) => {
      expect(command).toBe("git_working_tree_item");
      const input = args as { path: string; generation: string };
      paths.push(input.path);
      return new Promise((resolve) =>
        pending.push(() =>
          resolve({ ...input, state: "binary", before: null, after: null }),
        ),
      );
    });
    const reader = createItemReader();
    let active = true;
    const first = reader.read(scope, "contract/a", () => true);
    const second = reader.read(scope, "contract/b", () => true);
    const third = reader.read(scope, "contract/c", () => active);
    await Promise.resolve();
    expect(paths).toEqual(["contract/a", "contract/b"]);
    active = false;
    pending[0]();
    pending[1]();
    await Promise.all([first, second]);
    expect(await third).toBe(undefined);
    expect(paths.length).toBe(2);
    mockNativeIpc((_command, args) => ({
      ...(args as object),
      generation: "old",
      state: "binary",
      before: null,
      after: null,
    }));
    await assert.rejects(
      reader.read(scope, "contract/a", () => true),
      /Stale inspection result/,
    );
  },
);

readerTest(
  "open source bytes have a shared ceiling and explicit retry can use released capacity",
  async () => {
    const text = "x".repeat(512 * 1024);
    mockNativeIpc((_command, args) => ({
      ...(args as object),
      state: "no_content_diff",
      before: text,
      after: text,
    }));
    const reader = createItemReader();
    for (let index = 0; index < 8; index++)
      expect(
        (await reader.read(scope, `contract/${index}`, () => true))?.state,
      ).toBe("no_content_diff");
    const limited = await reader.read(scope, "contract/8", () => true);
    expect({
      state: limited?.state,
      before: limited?.before,
      after: limited?.after,
      budgetLimited: limited?.budgetLimited,
    }).toEqual({
      state: "truncated",
      before: null,
      after: null,
      budgetLimited: true,
    });
    reader.release("contract/0");
    expect((await reader.read(scope, "contract/8", () => true))?.state).toBe(
      "no_content_diff",
    );
  },
);

readerTest(
  "text preparation derives real change statistics and does not execute markup",
  async () => {
    const item = await prepareTextDiff({
      path: "contract/app.html",
      generation: "1",
      state: "text",
      before: "old\n",
      after: "<script>throw new Error('untrusted')</script>\n",
    });
    expect(item.state).toBe("text");
    expect(
      item.diff?.hunks.map((hunk) => [hunk.additionLines, hunk.deletionLines]),
    ).toEqual([[1, 1]]);
  },
);
