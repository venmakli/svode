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
  test("agent candidates render the agent avatar while people properties keep agent references unknown", async () => {
    const dom = await createTestDom();
    const { ActorSingleValue, ActorValue } = await import("./property-value");
    const { ActorControl } = await import("./property-controls/actor-control");
    const ref = "agent:01arz3ndektsv4rrffq69g5fav";
    const missingRef = "agent:01bx5zzkbkactav9wevgemmvrz";
    const agents = [
      { kind: "agent" as const, name: "Writer", reference: ref },
      {
        kind: "agent" as const,
        name: "Agent not found",
        reference: missingRef,
        state: "missing" as const,
      },
    ];
    const people = [{ name: "Ada Lovelace", email: "ada@example.test" }];
    const column = { name: "Agents", type: "actor" as const, multiple: true };
    try {
      await dom.render(
        <>
          <ActorSingleValue value={ref} actors={agents} />
          <ActorSingleValue value={missingRef} actors={agents} />
          <ActorValue column={column} value={[ref]} actors={agents} />
          <ActorControl
            column={column}
            value={[ref]}
            actors={agents}
            onChange={() => undefined}
          />
          <span data-testid="page-collection">
            <ActorSingleValue value={ref} actors={people} />
          </span>
        </>,
      );
      expect(dom.document.body.textContent?.includes("Writer")).toBe(true);
      expect(
        dom.document.body.textContent?.includes("Agent not found"),
      ).toBe(true);
      expect(
        dom.document.querySelectorAll('[data-agent-avatar="neutral"]').length,
      ).toBe(4);
      const pageValue = dom.document.querySelector(
        '[data-testid="page-collection"]',
      )!;
      expect(pageValue.querySelector("[data-agent-avatar]")).toBeNull();
      expect(pageValue.textContent).toBe(`A${ref}`);

      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>('[data-slot="popover-trigger"]')!
          .click();
      });
      const options = [
        ...dom.document.querySelectorAll<HTMLElement>("[cmdk-item]"),
      ];
      expect(options.map((option) => option.textContent)).toEqual(["Writer"]);
      expect(
        dom.document.querySelectorAll("[cmdk-group-heading]").length,
      ).toBe(1);
      expect(
        dom.document.querySelector("[cmdk-group-heading]")?.textContent,
      ).toBe("All");
    } finally {
      await dom.dispose();
    }
  });
}
