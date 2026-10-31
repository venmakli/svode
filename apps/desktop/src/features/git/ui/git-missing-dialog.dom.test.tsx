import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createTestDom } from "@/shared/testing/dom";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type { GitAvailabilityDto } from "@/platform/git/git-types";

if (process.env.SVODE_GIT_MISSING_DOM !== "1") {
  test("a Git older than the minimum blocks with its version and the update", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_GIT_MISSING_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  });
} else {
  const outdated: GitAvailabilityDto = {
    git: true,
    gitLfs: false,
    gitVersion: "2.30.1",
    gitLfsVersion: null,
    gitVersionSupported: false,
    gitMinimumVersion: "2.31.0",
  };
  let availability = outdated;

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

  test("the dialog names the Git found and how to update it until a check passes", async () => {
    const dom = await createTestDom();
    mockNativeIpc(async (command) => {
      if (command === "git_check_availability") return availability;
      throw new Error(command);
    });
    const { useGitAvailability } =
      await import("../hooks/use-git-availability");
    const { GitMissingDialog } = await import("./git-missing-dialog");
    const m = await import("@/paraglide/messages.js");
    function Shell() {
      const { available, availability, recheck } = useGitAvailability();
      return (
        <GitMissingDialog
          open={available === false}
          availability={availability}
          onRecheck={recheck}
        />
      );
    }
    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    const shows = (text: string) =>
      dialog()?.textContent?.includes(text) ?? false;
    try {
      await dom.render(<Shell />);
      await settle();
      expect(shows(m.git_outdated_title())).toBe(true);
      expect(
        shows(
          m.git_outdated_description({ version: "2.30.1", minimum: "2.31.0" }),
        ),
      ).toBe(true);
      expect(shows(m.git_missing_title())).toBe(false);
      expect(
        dialog()?.querySelector("pre")?.textContent?.includes("upgrade"),
      ).toBe(true);

      // Git updated in place: "Check again" lets the user in.
      availability = {
        ...outdated,
        gitVersion: "2.51.0",
        gitVersionSupported: true,
      };
      const recheck = Array.from(
        dialog()!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((button) => button.textContent === m.git_missing_recheck())!;
      await act(async () => recheck.click());
      await settle();
      expect(dialog()).toBeNull();

      // No Git at all keeps the install variant.
      availability = {
        ...outdated,
        git: false,
        gitVersion: null,
        gitVersionSupported: false,
      };
      await dom.render(null);
      await dom.render(<Shell />);
      await settle();
      expect(shows(m.git_missing_title())).toBe(true);
      expect(shows(m.git_missing_description())).toBe(true);
    } finally {
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });
}
