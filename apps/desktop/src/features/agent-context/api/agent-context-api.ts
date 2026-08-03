import {
  getAgentContextInstructions,
  refreshAgentContextInstructions,
  type AgentContextAvailabilityDto,
  type AgentContextInstructionsSnapshotDto,
  type AgentContextReferenceDto,
  listenAgentContextChanged,
} from "@/platform/agent-context/agent-context-api";

import type {
  AgentContextInstructionsSnapshot,
  AgentContextReference,
} from "../model/types";

export async function loadAgentContextInstructions(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextInstructionsSnapshot> {
  return toAgentContextInstructionsSnapshot(
    await getAgentContextInstructions(projectPath, spacePath),
  );
}

export async function refreshAgentContextInstructionsSnapshot(
  projectPath: string,
  spacePath: string,
): Promise<AgentContextInstructionsSnapshot> {
  return toAgentContextInstructionsSnapshot(
    await refreshAgentContextInstructions(projectPath, spacePath),
  );
}

export function listenAgentContextInvalidation(
  handler: (payload: { spacePath: string; paths: readonly string[] }) => void,
) {
  return listenAgentContextChanged((event) => handler(event.payload));
}

export function toAgentContextInstructionsSnapshot(
  dto: AgentContextInstructionsSnapshotDto,
): AgentContextInstructionsSnapshot {
  return Object.freeze({
    adapters: Object.freeze(
      dto.adapters.map((adapter) =>
        Object.freeze({
          capabilities: Object.freeze({
            contextDiscovery:
              adapter.capabilities.instructions.availability === "available",
            launch: false as const,
            modelSelection: false as const,
            permissions: false as const,
          }),
          displayName: adapter.displayName,
          executable: adapter.executable.executable,
          id: adapter.id,
          installed: adapter.executable.path !== null,
          nativeDefaultTarget: dto.targetRoot,
          version: adapter.executable.version,
        }),
      ),
    ),
    diagnostics: Object.freeze(
      dto.diagnostics.map((diagnostic) => diagnostic.message),
    ),
    generation: dto.generation,
    hasPersonalSources: dto.observedPersonalPaths.length > 0,
    rows: Object.freeze(
      dto.instructions.map((row) => {
        const rowDiagnostics = dto.diagnostics
          .filter(
            (diagnostic) =>
              diagnostic.path === row.path ||
              (row.canonicalPath !== null &&
                diagnostic.path === row.canonicalPath),
          )
          .map((diagnostic) => diagnostic.message);
        return Object.freeze({
          adapterId: row.adapterId,
          availability: row.availability,
          availabilityReason: row.reason,
          body: row.preview?.markdown ?? "",
          canonicalPath: row.canonicalPath ?? row.path,
          diagnostics: Object.freeze(rowDiagnostics),
          discoveryPath: row.path,
          filename: row.name,
          id: row.id,
          linkTargetPath:
            row.canonicalPath && row.canonicalPath !== row.path
              ? row.canonicalPath
              : null,
          ownerPath: row.owner.root,
          precedence: row.discovery.precedence,
          references: Object.freeze(
            row.references.map((reference) =>
              Object.freeze({
                path: reference.path,
                status: referenceStatus(reference),
              }),
            ),
          ),
          role: row.discovery.policy,
          scope: row.sourceKind === "personal" ? "personal" : "project",
          truncated: row.preview?.truncated ?? false,
        });
      }),
    ),
    targetPath: dto.targetRoot,
  });
}

function referenceStatus(
  reference: AgentContextReferenceDto,
): AgentContextReference["status"] {
  if (reference.availability === "available") return "available";
  const reason = reference.reason?.toLocaleLowerCase() ?? "";
  if (reason.includes("approval")) return "requires_client_approval";
  if (reason.includes("outside") || reason.includes("boundary")) {
    return "outside_boundary";
  }
  return unavailableReferenceStatus(reference.availability);
}

function unavailableReferenceStatus(
  availability: AgentContextAvailabilityDto,
): AgentContextReference["status"] {
  return availability === "recognized_only"
    ? "outside_boundary"
    : "unreadable";
}
