import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import type { QueryFilter } from "../model/types";

if (process.env.SVODE_AVATAR_DOM_PROCESS !== "1") {
  test("isolated avatar DOM integration 1", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AVATAR_DOM_PROCESS: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("filter and property avatar parity survives identity updates without changing filter intent", async () => {
    const dom = await createTestDom();
    const { ActorSingleValue } = await import("@/features/properties/display");
    const { FilterEditor } = await import("./query-controls");
    const changes: QueryFilter[] = [];
    const actor = {
      name: "Ada Lovelace",
      email: "person3@example.test",
      aliasEmails: ["old@example.test"],
    };
    try {
      for (const name of ["Ada Lovelace", "Илья Камнев", " "]) {
        actor.name = name;
        await dom.render(
          <>
            <ActorSingleValue value={actor.email} actors={[actor]} />
            <FilterEditor
              schema={{ columns: [{ name: "People", type: "actor" }] }}
              draft={{
                field: "People",
                op: "in",
                values: ["old@example.test"],
              }}
              actors={[actor]}
              onChange={(value) => {
                changes.push(value);
              }}
            />
          </>,
        );
        const avatars = [
          ...dom.document.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          ),
        ];
        expect(avatars.length).toBe(2);
        expect(avatars[1].textContent).toBe(avatars[0].textContent);
        expect(avatars[1].getAttribute("style")).toBe(
          avatars[0].getAttribute("style"),
        );
        expect(
          dom.document.querySelector("img, [data-slot=avatar-image]"),
        ).toBeNull();
      }
      const checkbox =
        dom.document.querySelector<HTMLButtonElement>('[role="checkbox"]')!;
      expect(checkbox.getAttribute("data-state")).toBe("checked");
      await act(async () => {
        checkbox.click();
      });
      expect(changes).toEqual([
        { field: "People", op: "in", value: undefined, values: [] },
      ]);
    } finally {
      await dom.dispose();
    }
  });
  test("an agent filter lists selectable agents by name and stores their reference", async () => {
    const dom = await createTestDom();
    const { FilterEditor } = await import("./query-controls");
    const changes: QueryFilter[] = [];
    const ref = "agent:01arz3ndektsv4rrffq69g5fav";
    const actors = [
      { kind: "agent" as const, name: "Writer", reference: ref },
      {
        kind: "agent" as const,
        name: "Analyst",
        reference: "agent:01bx5zzkbkactav9wevgemmvrz",
      },
      {
        kind: "agent" as const,
        name: "Loading agent…",
        reference: "agent:01c0000000000000000000000z",
        state: "loading" as const,
      },
    ];
    try {
      await dom.render(
        <FilterEditor
          schema={{ columns: [{ name: "Agent", type: "actor" }] }}
          draft={{ field: "Agent", op: "in", values: [] }}
          actors={actors}
          onChange={(value) => {
            changes.push(value);
          }}
        />,
      );
      const labels = () =>
        [...dom.document.querySelectorAll("label")].map(
          (label) => label.textContent,
        );
      expect(labels()).toEqual(["Writer", "Analyst"]);
      expect(
        dom.document.querySelectorAll('[data-agent-avatar="neutral"]').length,
      ).toBe(2);

      const search = dom.document.querySelector<HTMLInputElement>("input")!;
      const type = async (value: string) => {
        const view = search.ownerDocument.defaultView!;
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            view.HTMLInputElement.prototype,
            "value",
          )?.set?.call(search, value);
          search.dispatchEvent(new view.Event("input", { bubbles: true }));
        });
      };
      await type("01arz");
      expect(labels()).toEqual([]);
      await type("writ");
      expect(labels()).toEqual(["Writer"]);

      await act(async () => {
        dom.document
          .querySelector<HTMLButtonElement>('[role="checkbox"]')!
          .click();
      });
      expect(changes).toEqual([
        { field: "Agent", op: "in", value: undefined, values: [ref] },
      ]);
    } finally {
      await dom.dispose();
    }
  });
}
