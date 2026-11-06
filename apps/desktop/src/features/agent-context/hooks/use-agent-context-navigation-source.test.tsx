import { expect, test } from "bun:test";

import type { AgentContextSnapshot } from "../model/types";
import { agentContextNavigationSource } from "./use-agent-context-navigation-source";

function snapshot(
  diagnostics: AgentContextSnapshot["diagnostics"],
): AgentContextSnapshot {
  return {
    diagnostics,
    enabledAgents: ["codex"],
    generation: 1,
    hasPersonalSources: false,
    items: [],
    targetPath: "/project/space",
  };
}

test("the Context source confirms absence only after a read without diagnostics", () => {
  expect(agentContextNavigationSource(snapshot([])).confirmsAbsence).toBe(
    true,
  );
  expect(
    agentContextNavigationSource(
      snapshot([
        {
          adapterId: null,
          code: "skill_root_read",
          message: "permission denied",
          path: ".agents/skills",
          severity: "error",
        },
      ]),
    ).confirmsAbsence,
  ).toBe(false);
});
