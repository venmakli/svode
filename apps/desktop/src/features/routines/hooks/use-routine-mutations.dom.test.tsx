import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";

import { createTestDom } from "@/shared/testing/dom";

import type {
  RoutineCatalogSnapshot,
  RoutineDefinition,
  RoutineItem,
  RoutineMutationResult,
} from "../model/types";

// The writes of a Routine's properties from the panel: one after another on
// the version the previous one wrote, and a version conflict reads the
// catalog again instead of writing.
if (process.env.SVODE_ROUTINE_PROPERTY_WRITES_DOM !== "1") {
  test("routine property writes in an isolated process", () => {
    const child = spawnSync(
      process.execPath,
      ["test", fileURLToPath(import.meta.url)],
      {
        env: { ...process.env, SVODE_ROUTINE_PROPERTY_WRITES_DOM: "1" },
        encoding: "utf8",
      },
    );
    if (child.status !== 0) throw new Error(child.stdout + child.stderr);
    expect(child.status).toBe(0);
  }, 30_000);
} else {
  const owner = {
    ownerKind: "registered_space" as const,
    ownerPath: "/repo",
    projectPath: "/repo",
    spaceId: "root",
    spacePath: "/repo",
  };
  const definition: RoutineDefinition = {
    action: { executor: "agent:writer", type: "run_agent" },
    body: "Summarize.",
    description: "",
    enabled: true,
    name: "Digest",
    trigger: {
      cron: "0 9 * * *",
      missedRuns: "skip",
      timeBasis: { mode: "local" },
      type: "schedule",
    },
  };
  const routine = (fingerprint: string, value = definition): RoutineItem => ({
    definition: value,
    definitionPath: ".routines/digest.md",
    description: "",
    diagnostics: [],
    filename: "digest.md",
    fingerprint,
    id: "routine:digest",
    lastRun: null,
    lastRunAt: null,
    lastRunOrigin: null,
    name: value.name,
    nextRunAt: null,
    routineId: "routine:digest",
    valid: true,
  });
  const snapshotOf = (item: RoutineItem): RoutineCatalogSnapshot =>
    ({
      catalogFingerprint: item.fingerprint,
      diagnostics: [],
      items: [item],
    }) as unknown as RoutineCatalogSnapshot;

  const calls: { fingerprint: string; definition: RoutineDefinition }[] = [];
  let respond: (
    item: RoutineItem,
    definition: RoutineDefinition,
  ) => Promise<RoutineMutationResult> = async () => ({
    message: "unset",
    status: "blocked",
  });
  const realApi = await import("../api/routines-api");
  mock.module("../api/routines-api", () => ({
    ...realApi,
    deleteRoutine: async () => ({ message: "unused", status: "blocked" }),
    updateRoutine: async (
      _owner: unknown,
      item: RoutineItem,
      next: RoutineDefinition,
    ) => {
      calls.push({ definition: next, fingerprint: item.fingerprint });
      return respond(item, next);
    },
  }));
  mock.module("sonner", () => ({
    toast: { error() {}, success() {}, warning() {} },
  }));

  const { setLocale } = await import("@/paraglide/runtime");
  await setLocale("en", { reload: false });
  const m = await import("@/paraglide/messages.js");
  const { useRoutineMutations } = await import("./use-routine-mutations");

  type Mutations = ReturnType<typeof useRoutineMutations>;

  async function mountMutations({
    refresh,
    replaced,
  }: {
    refresh(): Promise<RoutineCatalogSnapshot | null>;
    replaced: RoutineCatalogSnapshot[];
  }) {
    const dom = await createTestDom();
    const handle: { current: Mutations | null } = { current: null };
    function Harness() {
      const mutations = useRoutineMutations({
        items: [],
        onDetailInvalidated: () => undefined,
        owner,
        refresh,
        replaceSnapshot: (snapshot) => replaced.push(snapshot),
      });
      useEffect(() => {
        handle.current = mutations;
      });
      return null;
    }
    await dom.render(<Harness />);
    return { dom, mutations: () => handle.current! };
  }

  test("two quick property writes of one Routine run in turn, the second on the version the first wrote, without losing either", async () => {
    calls.length = 0;
    let version = 1;
    respond = async (_item, next) => {
      version += 1;
      const written = routine(`fingerprint:${version}`, next);
      return {
        changedPaths: [".routines/digest.md"],
        routineId: "routine:digest",
        snapshot: snapshotOf(written),
        status: "applied",
        warnings: [],
      };
    };
    const replaced: RoutineCatalogSnapshot[] = [];
    const { dom, mutations } = await mountMutations({
      refresh: async () => null,
      replaced,
    });
    try {
      const shown = routine("fingerprint:1");
      let results: RoutineItem[] = [];
      await act(async () => {
        results = await Promise.all([
          mutations().writeProperty(shown, (value) => ({
            ...value,
            enabled: false,
          })),
          mutations().writeProperty(shown, (value) => ({
            ...value,
            description: "Daily",
          })),
        ]);
      });
      expect(calls.map((call) => call.fingerprint)).toEqual([
        "fingerprint:1",
        "fingerprint:2",
      ]);
      expect(calls[1]!.definition.enabled).toBe(false);
      expect(calls[1]!.definition.description).toBe("Daily");
      expect(results.map((item) => item.fingerprint)).toEqual([
        "fingerprint:2",
        "fingerprint:3",
      ]);
      expect(replaced.length).toBe(2);
    } finally {
      await dom.dispose();
    }
  });

  test("a version conflict writes nothing, reads the catalog again and rejects with the reason", async () => {
    calls.length = 0;
    respond = async () => ({ currentFingerprint: "disk", status: "stale" });
    const replaced: RoutineCatalogSnapshot[] = [];
    let refreshed = 0;
    const { dom, mutations } = await mountMutations({
      refresh: async () => {
        refreshed += 1;
        return snapshotOf(routine("disk"));
      },
      replaced,
    });
    try {
      let failure: unknown = null;
      await act(async () => {
        await mutations()
          .writeProperty(routine("fingerprint:1"), (value) => ({
            ...value,
            enabled: false,
          }))
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect(calls.length).toBe(1);
      expect(refreshed).toBe(1);
      expect(replaced).toEqual([]);
      expect((failure as Error).message).toBe(m.routines_property_stale());
      expect(mutations().error).toBeNull();
      expect(mutations().pending).toBe(false);
    } finally {
      await dom.dispose();
    }
  });

  test("a refused write rejects with the owner's reason and leaves the other actions available", async () => {
    calls.length = 0;
    respond = async () => ({
      message: "The repository is read-only",
      status: "blocked",
    });
    const { dom, mutations } = await mountMutations({
      refresh: async () => null,
      replaced: [],
    });
    try {
      let failure: unknown = null;
      await act(async () => {
        await mutations()
          .writeProperty(routine("fingerprint:1"), (value) => value)
          .catch((error: unknown) => {
            failure = error;
          });
      });
      expect((failure as Error).message).toBe("The repository is read-only");
      expect(mutations().pending).toBe(false);
      expect(mutations().error).toBeNull();
    } finally {
      await dom.dispose();
    }
  });
}
