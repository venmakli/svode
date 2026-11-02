import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect, useState } from "react";

import { createTestDom } from "@/shared/testing/dom";

import type { RoutineInstructionFlush } from "../hooks/use-routine-instruction-autosave";

// The instruction is saved by itself shortly after the last change, the
// leave guard waits for it, and a refused write shows the saved one again.
if (process.env.SVODE_ROUTINE_INSTRUCTION_DOM !== "1") {
  test("routine instruction autosave in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINE_INSTRUCTION_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  // The page editor stands in as a text field holding its Markdown.
  mock.module("@/features/editor", () => ({
    ControlledMarkdownEditor: ({
      value,
      onChange,
    }: {
      value: string;
      onChange(value: string): void;
    }) => (
      <textarea
        data-editor
        defaultValue={value}
        onChange={(event) => onChange(event.target.value)}
      />
    ),
  }));

  const { setLocale } = await import("@/paraglide/runtime");
  await setLocale("en", { reload: false });
  const { RoutineInstructionEditor } =
    await import("./routine-instruction-editor");
  const { ROUTINE_INSTRUCTION_SAVE_DELAY_MS } =
    await import("../hooks/use-routine-instruction-autosave");

  async function mount(save: (body: string) => Promise<void>) {
    const dom = await createTestDom();
    const handle: {
      flush: RoutineInstructionFlush | null;
      setBody: ((body: string) => void) | null;
    } = { flush: null, setBody: null };
    function Harness() {
      const [body, setBody] = useState("Summarize.");
      useEffect(() => {
        handle.setBody = setBody;
      }, []);
      return (
        <RoutineInstructionEditor
          body={body}
          disabled={false}
          label="Instruction"
          placeholder="Describe"
          registerFlush={(flush) => {
            handle.flush = flush;
          }}
          save={async (next) => {
            await save(next);
            setBody(next);
          }}
        />
      );
    }
    await dom.render(<Harness />);
    const editor = () =>
      dom.document.querySelector<HTMLTextAreaElement>("[data-editor]")!;
    const type = async (value: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          dom.document.defaultView!.HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(editor(), value);
        editor().dispatchEvent(
          new dom.document.defaultView!.Event("input", { bubbles: true }),
        );
      });
    };
    return { dom, editor, handle, type };
  }

  async function wait(ms: number) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  test("changes are saved once shortly after the last one, and the leave guard writes what is left at once", async () => {
    const saves: string[] = [];
    const { dom, handle, type } = await mount(async (body) => {
      saves.push(body);
    });
    try {
      await type("Summarize the");
      await type("Summarize the day.");
      expect(saves).toEqual([]);
      await wait(ROUTINE_INSTRUCTION_SAVE_DELAY_MS + 100);
      expect(saves).toEqual(["Summarize the day."]);

      await type("Summarize the week.");
      let flushed = false;
      await act(async () => {
        flushed = await handle.flush!();
      });
      expect(flushed).toBe(true);
      expect(saves).toEqual(["Summarize the day.", "Summarize the week."]);
      // Nothing is left to write after the guard.
      await wait(ROUTINE_INSTRUCTION_SAVE_DELAY_MS + 100);
      expect(saves.length).toBe(2);
    } finally {
      await dom.dispose();
    }
  });

  test("a refused write shows the saved instruction again with the reason", async () => {
    const { dom, editor, handle, type } = await mount(async () => {
      throw new Error("The Routine changed on disk");
    });
    try {
      await type("Lost words");
      let flushed = true;
      await act(async () => {
        flushed = await handle.flush!();
      });
      expect(flushed).toBe(false);
      expect(editor().value).toBe("Summarize.");
      expect(
        dom.document.querySelector("[data-routine-instruction-message]")
          ?.textContent,
      ).toBe("Instruction not saved: The Routine changed on disk");
    } finally {
      await dom.dispose();
    }
  });

  test("an update from disk replaces a saved instruction but not one still being typed", async () => {
    const { dom, editor, handle, type } = await mount(async () => undefined);
    try {
      await act(async () => handle.setBody!("Changed on disk."));
      expect(editor().value).toBe("Changed on disk.");
      await type("Typing over it");
      await act(async () => handle.setBody!("Changed again."));
      expect(editor().value).toBe("Typing over it");
    } finally {
      await dom.dispose();
    }
  });
}
