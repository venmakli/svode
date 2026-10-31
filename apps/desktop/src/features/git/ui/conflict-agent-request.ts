import type {
  ConflictAgentSituation,
  ConflictForAgent,
} from "../model/conflict-agent-request";
import { gitConflictKindLabel } from "./git-sync-stop-copy";
import * as m from "@/paraglide/messages.js";

/**
 * The request «Разрешить с агентом» puts into a chat composer (Stage 11
 * 1.F): what stopped in the repository, its unresolved conflicts with the
 * names the person knows them by, paths relative to the repository and
 * kinds, then the Git rules for agents (1.D) in their single wording.
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
  return [
    situation.kind === "merge"
      ? m.agent_conflict_request_merge({ path: repository })
      : m.agent_conflict_request_unmerged({ path: repository }),
    "",
    m.agent_conflict_request_files(),
    ...conflicts.map((conflict) =>
      conflictLine(conflict, nameOf(conflict.path)),
    ),
    "",
    rules.trim(),
  ].join("\n");
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
