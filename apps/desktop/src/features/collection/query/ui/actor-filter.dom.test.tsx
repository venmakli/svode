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
}
