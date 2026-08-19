import type { AgentContextDiagnostic, SupportedAdapterId } from "./types";

export type AgentContextDiagnosticGroupId =
  | "clients"
  | "instructions"
  | "skills"
  | "runtime"
  | "other";

export interface AgentContextDiagnosticRecord extends AgentContextDiagnostic {
  group: AgentContextDiagnosticGroupId;
  origin: "snapshot" | "runtime";
}

export interface AgentContextDiagnosticGroup {
  diagnostics: readonly AgentContextDiagnosticRecord[];
  id: AgentContextDiagnosticGroupId;
}

const groupOrder: readonly AgentContextDiagnosticGroupId[] = [
  "clients",
  "instructions",
  "skills",
  "runtime",
  "other",
];

export function buildAgentContextDiagnosticReadModel({
  diagnostics,
  refreshError,
}: {
  diagnostics: readonly AgentContextDiagnostic[];
  refreshError: string | null;
}): readonly AgentContextDiagnosticGroup[] {
  const records: AgentContextDiagnosticRecord[] = diagnostics.map(
    (diagnostic) => ({
      ...diagnostic,
      group: diagnosticGroup(diagnostic.code),
      origin: "snapshot",
    }),
  );

  if (refreshError) {
    records.push({
      adapterId: null,
      code: "background_refresh_failed",
      group: "runtime",
      message: refreshError,
      origin: "runtime",
      path: null,
      severity: "error",
    });
  }

  const unique = new Map<string, AgentContextDiagnosticRecord>();
  for (const record of records) {
    const identity = diagnosticIdentity(record);
    if (!unique.has(identity)) unique.set(identity, Object.freeze(record));
  }

  const ordered = [...unique.values()].sort(compareDiagnostics);
  return Object.freeze(
    groupOrder.flatMap((id) => {
      const groupDiagnostics = ordered.filter(
        (diagnostic) => diagnostic.group === id,
      );
      return groupDiagnostics.length > 0
        ? [
            Object.freeze({
              diagnostics: Object.freeze(groupDiagnostics),
              id,
            }),
          ]
        : [];
    }),
  );
}

export function countAgentContextDiagnostics(
  groups: readonly AgentContextDiagnosticGroup[],
): number {
  return groups.reduce((count, group) => count + group.diagnostics.length, 0);
}

function diagnosticGroup(code: string): AgentContextDiagnosticGroupId {
  if (code.startsWith("adapter_")) return "clients";
  if (code.startsWith("skill_")) return "skills";
  if (
    code.startsWith("instruction_") ||
    code.startsWith("codex_") ||
    code.startsWith("claude_")
  ) {
    return "instructions";
  }
  return "other";
}

function diagnosticIdentity(diagnostic: AgentContextDiagnosticRecord): string {
  return JSON.stringify([
    diagnostic.code,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.path,
    diagnostic.adapterId,
  ]);
}

function compareDiagnostics(
  left: AgentContextDiagnosticRecord,
  right: AgentContextDiagnosticRecord,
): number {
  return (
    compareStrings(left.group, right.group) ||
    compareNullableStrings(left.adapterId, right.adapterId) ||
    compareStrings(left.code, right.code) ||
    compareNullableStrings(left.path, right.path) ||
    compareStrings(left.severity, right.severity) ||
    compareStrings(left.message, right.message)
  );
}

function compareNullableStrings(
  left: SupportedAdapterId | string | null,
  right: SupportedAdapterId | string | null,
): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compareStrings(left, right);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
