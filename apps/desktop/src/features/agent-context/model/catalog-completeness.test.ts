import { expect, test } from "bun:test";

import { isAgentContextReadComplete } from "./catalog-completeness";
import type { AgentContextDiagnostic, AgentContextSnapshot } from "./types";

function snapshot(
  diagnostics: readonly AgentContextDiagnostic[],
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

test("a read of the Context without diagnostics is complete", () => {
  expect(isAgentContextReadComplete(snapshot([]))).toBe(true);
});

test("any diagnostic, known or unknown, may have lost an item", () => {
  for (const [code, severity] of [
    ["instruction_read", "error"],
    ["skill_root_read", "error"],
    ["skill_frontmatter_missing", "warning"],
    ["mcp_config_parse", "error"],
    ["plugin_component_parse", "warning"],
    ["future_problem", "warning"],
  ] as const) {
    expect(
      isAgentContextReadComplete(
        snapshot([
          { adapterId: null, code, message: code, path: null, severity },
        ]),
      ),
    ).toBe(false);
  }
});
