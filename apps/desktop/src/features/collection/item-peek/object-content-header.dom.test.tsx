import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useState } from "react";

import { createTestDom } from "@/shared/testing/dom";

// A saved name or description in the content header keeps the object the
// main area shows in Now; a refused, cancelled or unchanged one does not,
// and nothing outside the main area does.
if (process.env.SVODE_OBJECT_CONTENT_HEADER_DOM !== "1") {
  test("object content header edit signal in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_OBJECT_CONTENT_HEADER_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const { setLocale } = await import("@/paraglide/runtime");
  await setLocale("en", { reload: false });
  const { subscribeUserEdits, UserEditScope } =
    await import("@/features/navigation");
  const { ObjectContentHeader } = await import("./object-content-header");

  async function mount({
    mainArea = true,
    refuseTitle,
  }: { mainArea?: boolean; refuseTitle?: string } = {}) {
    const dom = await createTestDom();
    const window = dom.document.defaultView!;
    const commits: string[] = [];
    const edits: string[] = [];
    const unsubscribe = subscribeUserEdits((edit) => edits.push(edit.kind));

    function Harness() {
      const [title, setTitle] = useState("Daily summary");
      const [description, setDescription] = useState("Summarize the day.");
      return (
        <UserEditScope mainArea={mainArea}>
          <ObjectContentHeader
            icon={null}
            title={title}
            edit={{
              description,
              async onTitleCommit(next) {
                commits.push(`title:${next}`);
                if (refuseTitle) throw new Error(refuseTitle);
                setTitle(next);
              },
              async onDescriptionCommit(next) {
                commits.push(`description:${next}`);
                setDescription(next);
              },
            }}
          />
        </UserEditScope>
      );
    }
    await dom.render(<Harness />);

    const title = () =>
      dom.document.querySelector<HTMLTextAreaElement>(
        "[data-object-content-header-title]",
      )!;
    const description = () =>
      dom.document.querySelector<HTMLTextAreaElement>(
        "[data-object-content-header-description]",
      )!;
    const titleMessage = () =>
      dom.document.querySelector('[data-object-content-header-message="title"]')
        ?.textContent ?? null;

    async function run(action: () => unknown) {
      await act(async () => {
        await action();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    /** Types `value` into a text field as a user does. */
    function type(field: HTMLTextAreaElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      field.focus();
      setter.call(field, value);
      field.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
    function press(field: HTMLElement, key: string) {
      field.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key,
        }),
      );
    }

    return {
      commits,
      description,
      edits,
      press,
      run,
      title,
      titleMessage,
      type,
      async dispose() {
        unsubscribe();
        await dom.dispose();
      },
    };
  }

  test("a saved name and a saved description in the main area each signal an edit", async () => {
    const view = await mount();
    try {
      await view.run(() => view.type(view.title(), "Evening summary"));
      expect(view.edits).toEqual([]);
      await view.run(() => view.press(view.title(), "Enter"));
      expect(view.commits).toEqual(["title:Evening summary"]);
      expect(view.edits).toEqual(["edit"]);

      await view.run(() =>
        view.type(view.description(), "Summarize the evening."),
      );
      await view.run(() => view.description().blur());
      expect(view.commits).toEqual([
        "title:Evening summary",
        "description:Summarize the evening.",
      ]);
      expect(view.edits).toEqual(["edit", "edit"]);
    } finally {
      await view.dispose();
    }
  });

  test("an empty name, Escape and leaving a field unchanged signal nothing", async () => {
    const view = await mount();
    try {
      await view.run(() => view.type(view.title(), "   "));
      await view.run(() => view.title().blur());
      expect(view.titleMessage()).toBe("Name is required");
      expect(view.title().value).toBe("Daily summary");

      await view.run(() => view.type(view.title(), "Discarded"));
      await view.run(() => view.press(view.title(), "Escape"));
      expect(view.title().value).toBe("Daily summary");

      await view.run(() => view.type(view.title(), "Daily summary "));
      await view.run(() => view.title().blur());
      await view.run(() => view.description().focus());
      await view.run(() => view.description().blur());

      expect(view.commits).toEqual([]);
      expect(view.edits).toEqual([]);
    } finally {
      await view.dispose();
    }
  });

  test("a name the owner refuses signals nothing", async () => {
    const view = await mount({
      refuseTitle: "This name is already used in this owner.",
    });
    try {
      await view.run(() => view.type(view.title(), "Weekly"));
      await view.run(() => view.press(view.title(), "Enter"));
      expect(view.commits).toEqual(["title:Weekly"]);
      expect(view.titleMessage()).toBe(
        "This name is already used in this owner.",
      );
      expect(view.title().value).toBe("Daily summary");
      expect(view.edits).toEqual([]);
    } finally {
      await view.dispose();
    }
  });

  test("a saved edit outside the main area signals nothing", async () => {
    const view = await mount({ mainArea: false });
    try {
      await view.run(() => view.type(view.title(), "Evening summary"));
      await view.run(() => view.press(view.title(), "Enter"));
      await view.run(() => view.type(view.description(), "In a peek."));
      await view.run(() => view.description().blur());
      expect(view.commits).toEqual([
        "title:Evening summary",
        "description:In a peek.",
      ]);
      expect(view.edits).toEqual([]);
    } finally {
      await view.dispose();
    }
  });
}
