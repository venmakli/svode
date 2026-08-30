import { expect, test } from "bun:test";
import {
  ArtifactSurfaceTransitionSession,
  resolveArtifactSurfaceHost,
  type ArtifactSurfaceContribution,
} from "./surface-host";

function surface(
  id: string,
  options: Partial<ArtifactSurfaceContribution> = {},
): ArtifactSurfaceContribution {
  return {
    id,
    label: id,
    role: "view",
    availability: "available",
    isDefault: false,
    ...options,
  };
}

test("resolves one offered default while preserving a recoverable intent", () => {
  const host = resolveArtifactSurfaceHost([
    surface("edit", { availability: "recoverable" }),
    surface("view", { isDefault: true }),
    surface("internal", { availability: "unavailable" }),
  ]);

  expect(host.currentId).toBe("view");
  expect(host.defaultId).toBe("view");
  expect(host.contributions.map(({ id }) => id)).toEqual(["edit", "view"]);
});

test("rejects duplicate identities and ambiguous offered defaults", () => {
  let duplicateError = "";
  try {
    resolveArtifactSurfaceHost([
      surface("view", { isDefault: true }),
      surface("view"),
    ]);
  } catch (error) {
    duplicateError = String(error);
  }
  expect(duplicateError.includes("Duplicate artifact surface")).toBe(true);

  let defaultError = "";
  try {
    resolveArtifactSurfaceHost([surface("edit"), surface("view")]);
  } catch (error) {
    defaultError = String(error);
  }
  expect(defaultError.includes("requires one offered default")).toBe(true);
});

test("transition session blocks deactivation and ignores stale activation", async () => {
  const blocked = new ArtifactSurfaceTransitionSession();
  expect(
    await blocked.transition({
      deactivate: async (): Promise<"blocked"> => "blocked",
    }),
  ).toEqual({ status: "blocked" });

  const session = new ArtifactSurfaceTransitionSession();
  let release!: () => void;
  const first = session.transition({
    activate: (): Promise<"ready"> =>
      new Promise((resolve) => {
        release = () => resolve("ready");
      }),
  });
  const second = session.transition({ activate: () => "ready" });
  release();

  expect(await second).toEqual({ status: "activated" });
  expect(await first).toEqual({ status: "stale" });
});
