import type {
  ConflictAgentSituation,
  ConflictForAgent,
} from "../model/conflict-agent-request";
import { gitConflictKindLabel, gitOperationName } from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The request «Разрешить с агентом» or «Разобраться с агентом» puts into a
 * chat composer (Stage 11 1.F): what stopped in the repository (an
 * operation with its step when Git reports one), its unresolved conflicts
 * with the names the person knows them by, paths relative to the repository
 * and kinds, then the Git rules for agents (1.D) in their single wording.
 */
export function conflictAgentRequest({
  repository,
  situation,
  conflicts,
  nameOf,
  rules,
}: {
  repository: string;
  situation: ConflictAgentSituation;
  conflicts: readonly ConflictForAgent[];
  nameOf: (path: string) => string;
  rules: string;
}): string {
  const files =
    conflicts.length > 0
      ? [
          "",
          m.agent_conflict_request_files(),
          ...conflicts.map((conflict) =>
            conflictLine(conflict, nameOf(conflict.path)),
          ),
        ]
      : [];
  return [
    ...situationLines(situation, repository),
    ...files,
    "",
    rules.trim(),
  ].join("\n");
}

function situationLines(
  situation: ConflictAgentSituation,
  path: string,
): string[] {
  switch (situation.kind) {
    case "merge":
      return [m.agent_conflict_request_merge({ path })];
    case "unmerged":
      return [m.agent_conflict_request_unmerged({ path })];
    case "operation": {
      const lines = [
        m.agent_operation_request({
          operation: gitOperationName(situation.operation),
          path,
        }),
      ];
      if (situation.step?.kind === "position")
        lines.push(
          m.agent_operation_request_position({
            current: String(situation.step.current),
            total: String(situation.step.total),
          }),
        );
      else if (situation.step?.kind === "remaining")
        lines.push(
          m.agent_operation_request_remaining({
            count: String(situation.step.count),
          }),
        );
      return lines;
    }
  }
}

function conflictLine(conflict: ConflictForAgent, name: string): string {
  const paths = [conflict.path, ...conflict.also]
    .map((path) => `\`${path}\``)
    .join(", ");
  // A file known by its own name is named by its path alone.
  const file = conflict.path.split("/").at(-1);
  const named = name && name !== file && name !== conflict.path;
  const kind = conflict.kind ? ` (${gitConflictKindLabel(conflict.kind)})` : "";
  return `- ${named ? `${name}: ${paths}` : paths}${kind}`;
}
