import { expect, test } from "bun:test";

import { getLocale, setLocale } from "@/paraglide/runtime.js";

import type {
  AgentActorAdapterDiagnostic,
  AgentActorApprovalMapping,
} from "../model/agent-actor-types";
import {
  agentActorApprovalDescription,
  agentActorApprovalLabel,
  agentActorDiagnosticStatus,
  agentActorDiagnosticSummary,
  agentActorEffectiveBoundary,
  agentActorSelectorLabel,
} from "./agent-actor-copy";

const nativeModes: readonly AgentActorApprovalMapping["native"][] = [
  "codex_user_review",
  "codex_auto_review",
  "codex_full_access",
  "claude_default",
  "claude_auto",
  "claude_bypass_permissions",
];

test("Agent Actor semantic copy follows locale without backend presentation strings", async () => {
  const originalLocale = getLocale();
  try {
    await setLocale("en", { reload: false });
    expect(String(agentActorApprovalLabel("full"))).toBe("Full access");
    expect(
      String(agentActorEffectiveBoundary("codex_full_access")).includes(
        "Codex bypasses confirmations",
      ),
    ).toBe(true);
    expect(agentActorSelectorLabel(null)).toBe("Client default");

    await setLocale("ru", { reload: false });
    const copy = [
      ...(["ask", "auto", "full"] as const).flatMap((mode) => [
        agentActorApprovalLabel(mode),
        agentActorApprovalDescription(mode),
      ]),
      ...nativeModes.map(agentActorEffectiveBoundary),
      agentActorSelectorLabel(null),
      agentActorDiagnosticStatus(undefined),
      agentActorDiagnosticStatus(diagnostic("ready")),
      agentActorDiagnosticStatus(diagnostic("missing")),
      agentActorDiagnosticSummary(diagnostic("missing")) ?? "",
      agentActorDiagnosticSummary(diagnostic("unauthenticated")) ?? "",
      agentActorDiagnosticSummary(diagnostic("unknown")) ?? "",
    ].join(" ");

    expect(copy.includes("Полный доступ")).toBe(true);
    expect(copy.includes("По умолчанию клиента")).toBe(true);
    expect(copy.includes("Клиент не найден")).toBe(true);
    expect(
      /Full access|native boundary|first-run|Client default|Fallback|\bModel\b|\bEffort\b/.test(
        copy,
      ),
    ).toBe(false);
  } finally {
    await setLocale(originalLocale, { reload: false });
  }
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
