import { expect, test } from "bun:test";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type { AgentActorAdapterDiagnostic } from "../model/agent-actor-types";
import {
  agentActorBindingLabel,
  agentActorDiagnosticStatus,
  agentActorDiagnosticSummary,
} from "./agent-actor-copy";

const agents = [{ id: "codex", label: "Codex" }];

test("Agent Actor semantic copy follows locale without backend presentation strings", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    expect(
      String(agentActorBindingLabel({ kind: "participant" }, agents)),
    ).toBe("Participant's agent");

    await setLocale("ru", { reload: false });
    const copy = [
      agentActorBindingLabel({ kind: "participant" }, agents),
      agentActorDiagnosticStatus(undefined),
      agentActorDiagnosticStatus(diagnostic("ready")),
      agentActorDiagnosticStatus(diagnostic("missing")),
      agentActorDiagnosticSummary(diagnostic("missing")) ?? "",
      agentActorDiagnosticSummary(diagnostic("unauthenticated")) ?? "",
      agentActorDiagnosticSummary(diagnostic("unknown")) ?? "",
    ].join(" ");

    expect(copy.includes("Агент участника")).toBe(true);
    expect(copy.includes("Клиент не найден")).toBe(true);
    expect(/Participant|Ready|Missing/.test(copy)).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
});

test("a binding is named by its agent, an unknown id as it is, or the participant's agent", () => {
  expect(
    agentActorBindingLabel(
      { agent: "codex", kind: "agent", settings: [] },
      agents,
    ),
  ).toBe("Codex");
  expect(
    agentActorBindingLabel(
      { agent: "future-agent", kind: "agent", settings: [] },
      agents,
    ),
  ).toBe("future-agent");
});

function diagnostic(
  status: AgentActorAdapterDiagnostic["status"],
): AgentActorAdapterDiagnostic {
  return {
    adapter: "codex",
    authenticated: status === "ready" ? true : null,
    code: status === "ready" ? null : `adapter_${status}`,
    executablePath: status === "missing" ? null : "/bin/codex",
    message: status === "ready" ? null : "raw client detail",
    status,
    version: status === "missing" ? null : "1.0",
  };
}
