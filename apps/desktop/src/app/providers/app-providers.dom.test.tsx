import { expect, test } from "bun:test";
import * as bunTest from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import type { GitAvailabilityDto } from "@/platform/git/git-types";

const scenario = process.env.SVODE_APP_PROVIDERS_GIT_DOM;

// Each scenario needs a fresh identity store, so each runs in its own process.
if (!scenario) {
  for (const name of ["startup", "identity-refusal", "unreadable-config"]) {
    test(`root providers Git check: ${name}`, () => {
      const child = spawnSync(
        process.execPath,
        ["test", fileURLToPath(import.meta.url)],
        {
          env: { ...process.env, SVODE_APP_PROVIDERS_GIT_DOM: name },
          encoding: "utf8",
        },
      );
      if (child.status !== 0) throw new Error(child.stdout + child.stderr);
      expect(child.status).toBe(0);
    });
  }
} else {
  const bunMock = (
    bunTest as typeof bunTest & {
      mock: { module(specifier: string, factory: () => unknown): void };
    }
  ).mock;
  const passThrough = ({ children }: { children: ReactNode }) => children;
  const router = await import("@tanstack/react-router");
  // The routed screens behind the gates: the home without projects on a
  // first start.
  bunMock.module("@tanstack/react-router", () => ({
    ...router,
    Outlet: () => <div data-empty-home />,
  }));
  bunMock.module("@/features/settings", () => ({
    AppPreferencesProvider: passThrough,
    useAppLocale: () => undefined,
    useAppVersion: () => "0.0.0",
  }));
  bunMock.module("@/features/updates", () => ({
    DogfoodUpdatesProvider: passThrough,
  }));
  bunMock.module("@/features/agent-sessions", () => ({
    useDictatedDrafts: () => undefined,
  }));
  bunMock.module("@/features/home", () => ({
    RootProjectMenuBridge: () => null,
  }));
  bunMock.module("@/features/page", () => ({
    PageFilenameWarningDialog: () => null,
  }));
  bunMock.module("@/components/ui/sonner", () => ({ Toaster: () => null }));
  bunMock.module("./settings-dialogs", () => ({
    SettingsDialogs: () => null,
  }));

  const { createTestDom } = await import("@/shared/testing/dom");
  const { clearNativeMocks, mockNativeIpc } =
    await import("@/platform/native/testing");
  const m = await import("@/paraglide/messages.js");

  const supported: GitAvailabilityDto = {
    git: true,
    gitLfs: false,
    gitVersion: "2.51.0",
    gitLfsVersion: null,
    gitVersionSupported: true,
    gitMinimumVersion: "2.31.0",
  };
  const outdated: GitAvailabilityDto = {
    ...supported,
    gitVersion: "2.30.1",
    gitVersionSupported: false,
  };
  const missing: GitAvailabilityDto = {
    ...supported,
    git: false,
    gitVersion: null,
    gitVersionSupported: false,
  };
  const identity = {
    global: { name: "Alice", email: "alice@example.test" },
    source: "global",
    fingerprint: "v1",
  };

  let gitAvailability = supported;
  let identityAnswer: () => unknown = () => identity;
  let identityReads = 0;

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

  test(scenario, async () => {
    const dom = await createTestDom();
    mockNativeIpc(
      async (command) => {
        if (command === "git_check_availability") return gitAvailability;
        if (command === "get_git_identity") {
          identityReads += 1;
          return identityAnswer();
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );
    const { AppProviders } = await import("./app-providers");

    const dialog = () =>
      dom.document.querySelector<HTMLElement>("[role=dialog]");
    const shows = (text: string) =>
      dialog()?.textContent?.includes(text) ?? false;
    const text = () => dom.document.body.textContent ?? "";
    const home = () => dom.document.querySelector("[data-empty-home]");
    const recheck = async () => {
      const button = Array.from(
        dialog()!.querySelectorAll<HTMLButtonElement>("button"),
      ).find((candidate) => candidate.textContent === m.git_missing_recheck())!;
      await act(async () => button.click());
      await settle();
    };
    const outdatedShown = () =>
      shows(m.git_outdated_title()) &&
      shows(
        m.git_outdated_description({ version: "2.30.1", minimum: "2.31.0" }),
      );

    try {
      if (scenario === "startup") {
        // No Git: the install dialog, before Git Identity is read.
        gitAvailability = missing;
        await dom.render(<AppProviders />);
        await settle();
        expect(shows(m.git_missing_title())).toBe(true);
        expect(shows(m.git_missing_description())).toBe(true);
        expect(identityReads).toBe(0);
        expect(text().includes(m.identity_load_error_title())).toBe(false);
        expect(home()).toBeNull();
        await dom.render(null);

        // Git older than the minimum: the update dialog with both versions,
        // over the start screen instead of the empty home.
        gitAvailability = outdated;
        await dom.render(<AppProviders />);
        await settle();
        expect(outdatedShown()).toBe(true);
        expect(identityReads).toBe(0);
        expect(text().includes(m.identity_load_error_title())).toBe(false);
        expect(home()).toBeNull();

        // Git updated in place: "Check again" reads the identity and opens
        // the home without a restart.
        gitAvailability = supported;
        await recheck();
        expect(dialog()).toBeNull();
        expect(identityReads > 0).toBe(true);
        expect(home() !== null).toBe(true);
      }

      if (scenario === "identity-refusal") {
        // Git went too old between the check and the identity read: the read
        // refusal goes back to the Git check, not to the identity screen.
        identityAnswer = () => {
          gitAvailability = outdated;
          throw {
            kind: "git_unsupported",
            message: "Git 2.30.1 is older than 2.31.0",
            version: "2.30.1",
            minimumVersion: "2.31.0",
          };
        };
        await dom.render(<AppProviders />);
        await settle();
        await settle();
        expect(identityReads > 0).toBe(true);
        expect(outdatedShown()).toBe(true);
        expect(text().includes(m.identity_load_error_title())).toBe(false);
        expect(home()).toBeNull();

        gitAvailability = supported;
        identityAnswer = () => identity;
        await recheck();
        await settle();
        expect(dialog()).toBeNull();
        expect(text().includes(m.identity_load_error_title())).toBe(false);
        expect(home() !== null).toBe(true);
      }

      if (scenario === "unreadable-config") {
        // Any other read failure keeps the identity error screen.
        identityAnswer = () => {
          throw { kind: "git_command_failed", message: "bad config line 3" };
        };
        await dom.render(<AppProviders />);
        await settle();
        await settle();
        expect(text().includes(m.identity_load_error_title())).toBe(true);
        expect(dialog()).toBeNull();
        expect(home()).toBeNull();
      }
    } finally {
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  });
}
