import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_AVATAR_DOM_PROCESS !== "0") {
  test("isolated avatar DOM integration 0", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AVATAR_DOM_PROCESS: "0" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("display, picker, stack and chips share canonical local avatars and preserve selection", async () => {
    const dom = await createTestDom();
    const { humanAvatar } = await import("@/features/identity");
    const { ActorSingleValue, ActorValue } = await import("./property-value");
    const { ActorControl } = await import("./property-controls/actor-control");
    const changes: unknown[] = [];
    const column = { name: "People", type: "actor" as const, multiple: true };
    const actors = [
      {
        name: "Ada Lovelace",
        email: "person3@example.test",
        aliasEmails: ["old@example.test"],
      },
    ];
    try {
      for (const name of ["Ada Lovelace", "Илья Камнев", " "]) {
        actors[0].name = name;
        await dom.render(
          <>
            <ActorSingleValue value="old@example.test" actors={actors} />
            <ActorValue
              column={column}
              value={["old@example.test"]}
              actors={actors}
            />
            <ActorControl
              column={column}
              value={["old@example.test"]}
              actors={actors}
              onChange={(value) => {
                changes.push(value);
              }}
            />
          </>,
        );
        const expected = humanAvatar(actors[0]);
        const avatars = [
          ...dom.document.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          ),
        ];
        expect(avatars.length).toBe(3);
        for (const avatar of avatars) {
          expect(avatar.textContent).toBe(expected.initials);
          expect(avatar.style.backgroundColor).toBe("rgb(236, 72, 153)");
        }
        expect(
          dom.document.querySelector("img, [data-slot=avatar-image]"),
        ).toBeNull();
      }
      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')!
          .click();
      });
      const options = dom.document.querySelectorAll<HTMLElement>("[cmdk-item]");
      expect(options.length).toBe(1);
      expect(
        dom.document.querySelectorAll('[data-slot="avatar-fallback"]').length,
      ).toBe(4);
      expect(
        dom.document.querySelector("img, [data-slot=avatar-image]"),
      ).toBeNull();
      await act(async () => {
        options[0].click();
      });
      expect(changes).toEqual([[]]);
      actors[0].email = "person6@example.test";
      await dom.render(
        <ActorSingleValue value="old@example.test" actors={actors} />,
      );
      expect(
        dom.document.querySelector<HTMLElement>(
          '[data-slot="avatar-fallback"]',
        )!.style.backgroundColor,
      ).toBe("rgb(139, 92, 246)");
    } finally {
      await dom.dispose();
    }
  });
}
