import { expect, test } from "bun:test";
import { useEffect } from "react";

import { clearNativeMocks, mockNativeIpc } from "@/platform/native/testing";
import { createTestDom } from "@/shared/testing/dom";

import type { RoutineItem } from "../model/types";
import { useRoutineDispatch } from "./use-routine-dispatch";

const routine: RoutineItem = {
  definition: {
    action: { executor: "", type: "run_agent" },
    body: "",
    description: "",
    enabled: null,
    name: "New routine",
    trigger: { type: "manual" },
  },
  definitionPath: ".routines/new-routine.md",
  description: "",
  diagnostics: [],
  filename: "new-routine.md",
  fingerprint: "fingerprint:new",
  id: "routine:new",
  lastRun: null,
  lastRunAt: null,
  lastRunOrigin: null,
  name: "New routine",
  nextRunAt: null,
  routineId: "routine:new",
  valid: true,
};

test("a valid Routine without an executor cannot be run, with the reason", async () => {
  const { setLocale } = await import("@/paraglide/runtime");
  await setLocale("en", { reload: false });
  const dom = await createTestDom();
  mockNativeIpc(() => []);
  const handle: { current: ReturnType<typeof useRoutineDispatch> | null } = {
    current: null,
  };
  function Harness() {
    const dispatch = useRoutineDispatch({
      onOpenSession: () => undefined,
      owner: {
        ownerKind: "registered_space",
        ownerPath: "/repo",
        projectPath: "/repo",
        spaceId: "root",
        spacePath: "/repo",
      },
    });
    useEffect(() => {
      handle.current = dispatch;
    });
    return null;
  }
  try {
    await dom.render(<Harness />);
    expect(handle.current!.getRunState(routine)).toEqual({
      reason: "Choose an executor to run the routine.",
      status: "disabled",
    });
    let refused: unknown = null;
    await handle.current!.run(routine).catch((error: unknown) => {
      refused = error;
    });
    expect((refused as Error).message).toBe(
      "Choose an executor to run the routine.",
    );
  } finally {
    clearNativeMocks();
    await dom.dispose();
  }
});
