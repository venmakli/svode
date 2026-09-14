import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";

if (process.env.SVODE_AVATAR_DOM_PROCESS !== "3") {
  test("isolated avatar DOM integration 3", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_AVATAR_DOM_PROCESS: "3" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 20000);
} else {
  test("effective identity summary matches properties, refreshes and retains edit intent", async () => {
    const dom = await createTestDom();
    const { ActorSingleValue } = await import("@/features/properties/display");
    const { IdentitySection } = await import("./identity-section");
    let edits = 0;
    const noop = () => {};
    try {
      for (const identity of [
        { name: "Ada Lovelace", email: "person3@example.test" },
        { name: "Илья", email: "person6@example.test" },
        { name: " ", email: " EMAIL@example.test " },
        null,
      ]) {
        await dom.render(
          <>
            {identity && (
              <ActorSingleValue value={identity.email} actors={[identity]} />
            )}
            <IdentitySection
              mode="summary"
              isRoot={false}
              scopeName="Repo"
              repoIdentity={{
                effective: identity,
                local: null,
                source: identity ? "partial" : "missing",
              }}
              identityName="Unrelated draft"
              identityEmail="draft@example.test"
              setIdentityName={noop}
              setIdentityEmail={noop}
              identityFormError={null}
              savingIdentity={false}
              canResetIdentity={false}
              onEdit={() => {
                edits++;
              }}
              onCancelEdit={noop}
              onSave={noop}
              onReset={noop}
              fanoutEnabled={false}
              setFanoutEnabled={noop}
              fanoutPreview={[]}
              fanoutSelected={{}}
              setFanoutSelected={noop}
            />
          </>,
        );
        const avatars = [
          ...dom.document.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          ),
        ];
        if (identity) {
          expect(avatars.length).toBe(2);
          expect(avatars[1].textContent).toBe(avatars[0].textContent);
          expect(avatars[1].getAttribute("style")).toBe(
            avatars[0].getAttribute("style"),
          );
        } else {
          expect(avatars[0].textContent).toBe("?");
          expect(avatars[0].style.backgroundColor).toBe("rgb(156, 163, 175)");
        }
        expect(
          dom.document.querySelector("img, [data-slot=avatar-image]"),
        ).toBeNull();
        await act(async () => {
          dom.document.querySelector<HTMLButtonElement>("button")!.click();
        });
      }
      expect(edits).toBe(4);
    } finally {
      await dom.dispose();
    }
  });
}
