import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act } from "react";

import { emit as emitNativeEvent } from "@/platform/native/events";
import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import type {
  RoutineCatalogSnapshotDto,
  RoutineInvalidatedEventDto,
  RoutineLaunchLinkDto,
} from "@/platform/routines/routines-api";
import { createTestDom } from "@/shared/testing/dom";

import type { RoutineOwnerInput } from "../api/routines-api";
import { useRoutineCatalog } from "./use-routine-catalog";
import { useRoutineLaunchLinks } from "./use-routine-launch-links";
import { useRoutineNavigationSource } from "./use-routine-navigation-source";

const collectionEvent = process.env.SVODE_ROUTINE_EVENT_FIXTURE
  ? (JSON.parse(
      readFileSync(process.env.SVODE_ROUTINE_EVENT_FIXTURE, "utf8"),
    ) as RoutineInvalidatedEventDto)
  : ({
      projectPath: "C:\\Project Дела",
      spacePath: "C:\\Project Дела\\Child Space",
      ownerKind: "collection",
      ownerPath: "Tasks",
    } satisfies RoutineInvalidatedEventDto);

const projectEvent: RoutineInvalidatedEventDto = {
  ...collectionEvent,
  spacePath: collectionEvent.projectPath,
  ownerKind: "project",
  ownerPath: ".",
};
const spaceEvent: RoutineInvalidatedEventDto = {
  ...collectionEvent,
  ownerKind: "space",
  ownerPath: ".",
};
const otherProject = "D:\\Other Project";
const routineId = "01arz3ndektsv4rrffq69g5fav";
const executor = `agent:${routineId}`;
const session = { id: "session-1", launchId: "launch-1" };

test.each([projectEvent, spaceEvent, collectionEvent])(
  "a Routine file event updates the catalog and navigation of its resolved owner",
  async (event) => {
    const dom = await createTestDom();
    const initial = deferred<RoutineCatalogSnapshotDto>();
    const refreshed = deferred<RoutineCatalogSnapshotDto>();
    let refreshes = 0;
    mockNativeIpc(
      (command) => {
        if (command === "routines_list") return initial.promise;
        if (command === "routines_refresh") {
          refreshes++;
          return refreshed.promise;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      { shouldMockEvents: true },
    );

    const owner: RoutineOwnerInput = {
      ...event,
      ownerKind:
        event.ownerKind === "collection"
          ? "collection_directory"
          : "registered_space",
      spaceId: event.ownerKind === "project" ? "root" : "child",
    };
    const titleOf = (field: string) =>
      dom.document.querySelector(`[data-title="${field}"]`)?.textContent;

    try {
      await dom.render(<CatalogHarness owner={owner} />);
      await act(async () => {
        await emitNativeEvent("routines:invalidated", event);
        await emitNativeEvent("routines:invalidated", event);
        expect(refreshes).toBe(0);
        initial.resolve(snapshot(event, "Before"));
      });
      expect(titleOf("catalog")).toBe("Before");
      expect(titleOf("navigation")).toBe("Before");

      await act(async () => {
        const deadline = performance.now() + 2_000;
        while (refreshes < 2 && performance.now() < deadline) {
          await Bun.sleep(10);
        }
        refreshed.resolve(snapshot(event, "After"));
      });
      expect(refreshes).toBe(2);
      expect(titleOf("catalog")).toBe("After");
      expect(titleOf("navigation")).toBe("After");

      await act(async () => {
        for (const unrelated of [
          { ...event, projectPath: otherProject },
          { ...event, spacePath: `${event.projectPath}\\Neighbor Space` },
          {
            ...event,
            ownerKind: event.ownerKind === "space" ? "project" : "space",
          },
          { ...event, ownerPath: "Neighbor" },
        ]) {
          await emitNativeEvent("routines:invalidated", unrelated);
        }
        await Bun.sleep(150);
      });
      expect(refreshes).toBe(2);
      expect(titleOf("catalog")).toBe("After");
      expect(titleOf("navigation")).toBe("After");
    } finally {
      await dom.render(null);
      clearNativeMocks();
      await dom.dispose();
    }
  },
);

test("a Routine file event refreshes open session links by project", async () => {
  const dom = await createTestDom();
  const renamed = deferred<RoutineLaunchLinkDto[]>();
  const late = deferred<RoutineLaunchLinkDto[]>();
  const calls: string[] = [];
  mockNativeIpc(
    (command, args) => {
      if (command !== "routines_resolve_launches")
        throw new Error(`Unexpected command: ${command}`);
      const { projectPath, launchIds, sessionIds } = args as {
        projectPath: string;
        launchIds: string[];
        sessionIds: string[];
      };
      expect(launchIds).toEqual([session.launchId]);
      expect(sessionIds).toEqual([]);
      calls.push(projectPath);
      if (projectPath === otherProject) return [link("Other Project")];
      if (calls.length === 1) return [link("Before")];
      return calls.length === 2 ? renamed.promise : late.promise;
    },
    { shouldMockEvents: true },
  );
  const name = () => dom.document.querySelector("[data-link]")?.textContent;

  try {
    await dom.render(
      <LaunchLinkHarness projectPath={collectionEvent.projectPath} />,
    );
    expect(name()).toBe("Before");
    await act(async () => {
      await emitNativeEvent("routines:invalidated", {
        ...collectionEvent,
        projectPath: otherProject,
      });
    });
    expect(calls).toEqual([collectionEvent.projectPath]);

    await act(async () => {
      await emitNativeEvent("routines:invalidated", collectionEvent);
    });
    expect(calls).toHaveLength(2);
    expect(name()).toBe("Before");
    await act(async () => {
      renamed.resolve([link("After")]);
    });
    expect(name()).toBe("After");

    await act(async () => {
      await emitNativeEvent("routines:invalidated", projectEvent);
    });
    expect(calls).toHaveLength(3);
    await dom.render(<LaunchLinkHarness projectPath={otherProject} />);
    expect(name()).toBe("Other Project");
    await act(async () => {
      late.resolve([link("Late previous project")]);
    });
    expect(name()).toBe("Other Project");
  } finally {
    await dom.render(null);
    clearNativeMocks();
    await dom.dispose();
  }
});

function CatalogHarness({ owner }: { owner: RoutineOwnerInput }) {
  const { state } = useRoutineCatalog(owner);
  const navigation = useRoutineNavigationSource(owner);
  return (
    <>
      <span data-title="catalog">
        {state.phase === "ready" ? state.snapshot.items[0]?.name : state.phase}
      </span>
      <span data-title="navigation">
        {navigation?.items.get(routineId)?.title}
      </span>
    </>
  );
}

function LaunchLinkHarness({ projectPath }: { projectPath: string }) {
  const routineOf = useRoutineLaunchLinks(projectPath, [session]);
  return <span data-link>{routineOf(session)?.name}</span>;
}

function snapshot(
  event: RoutineInvalidatedEventDto,
  name: string,
): RoutineCatalogSnapshotDto {
  return {
    owner: {
      kind: event.ownerKind,
      ownerPath: event.ownerPath,
      spaceId: event.ownerKind === "project" ? "root" : "child",
    },
    catalogFingerprint: name,
    diagnostics: [],
    refreshedAt: "2026-11-24T00:00:00.000Z",
    routines: [
      {
        routineId,
        name,
        filename: "daily.md",
        path: ".routines/daily.md",
        description: null,
        enabled: true,
        triggerType: "manual",
        triggerSummary: null,
        actionType: "run_agent",
        actionSummary: null,
        executor,
        lastRunAt: null,
        nextRunAt: null,
        fingerprint: name,
        executionFingerprint: "unchanged",
        definition: {
          name,
          enabled: true,
          trigger: { type: "manual" },
          action: { type: "run_agent", executor },
          body: "Run daily.\n",
        },
        diagnostics: [],
      },
    ],
  };
}

function link(name: string): RoutineLaunchLinkDto {
  return {
    launchId: session.launchId,
    agentSessionId: session.id,
    launch: { transport: "acp" },
    definitionPresent: true,
    routineId,
    ownerKind: collectionEvent.ownerKind,
    ownerPath: collectionEvent.ownerPath,
    spaceId: "child",
    name,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
