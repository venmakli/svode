import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import type { ActorCatalogRow } from "../model/types";

if (process.env.SVODE_AVATAR_DOM_PROCESS !== "2") {
  test("isolated avatar DOM integration 2", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AVATAR_DOM_PROCESS: "2" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("contributors and merge picker match properties, preserve shape and canonical merge intent", async () => {
    const dom = await createTestDom();
    const { ActorSingleValue } = await import("@/features/properties/display");
    const { ActorAvatar } = await import("./actor-avatar");
    const { ActorMergePicker } = await import("./actor-merge-picker");
    const selected: string[] = [];
    const actor: ActorCatalogRow = {
      canonicalEmail: "person3@example.test",
      displayName: "Ada Lovelace",
      aliases: [],
      availableYears: [],
      commitCount: 0,
      contribution: "no_commits",
      lastActivityDate: null,
      lastCommitAt: null,
      sources: [],
    };
    try {
      for (const displayName of ["Ada Lovelace", "Илья Камнев", " "]) {
        actor.displayName = displayName;
        await dom.render(
          <>
            <ActorSingleValue
              value={actor.canonicalEmail}
              actors={[{ name: displayName, email: actor.canonicalEmail }]}
            />
            <ActorAvatar actor={actor} size="lg" />
            <ActorMergePicker
              pending={false}
              rows={[actor]}
              selectedEmail={null}
              onSelect={(value) => {
                selected.push(value);
              }}
            />
          </>,
        );
        const avatars = [
          ...dom.document.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          ),
        ];
        expect(avatars.length).toBe(3);
        for (const avatar of avatars.slice(1)) {
          expect(avatar.textContent).toBe(avatars[0].textContent);
          expect(avatar.getAttribute("style")).toBe(
            avatars[0].getAttribute("style"),
          );
          expect(avatar.classList.contains("rounded-lg")).toBe(true);
        }
        expect(
          dom.document.querySelector("img, [data-slot=avatar-image]"),
        ).toBeNull();
      }
      await act(async () => {
        dom.document.querySelector<HTMLElement>("[cmdk-item]")!.click();
      });
      expect(selected).toEqual([actor.canonicalEmail]);
    } finally {
      await dom.dispose();
    }
  });
}
