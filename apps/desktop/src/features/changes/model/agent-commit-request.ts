import type {
  GitUncommittedGroupDto,
  GitUncommittedGroupsDto,
} from "@/platform/git/git-types";
import * as m from "@/paraglide/messages.js";

/** The area of a "Changes" window in one Space: its uncommitted paths. */
export interface AreaPart {
  spacePath: string;
  /** Relative to the Space. */
  paths: string[];
}

/**
 * The uncommitted groups of the parts by repository, in the order the
 * repositories first appear; groups of two Spaces of one repository join.
 */
export function groupsByRepository(
  found: readonly GitUncommittedGroupsDto[],
): GitUncommittedGroupsDto[] {
  const sections: GitUncommittedGroupsDto[] = [];
  for (const part of found) {
    if (part.groups.length === 0) continue;
    const section = sections.find(
      (known) => known.repository === part.repository,
    );
    if (section) section.groups.push(...part.groups);
    else sections.push({ repository: part.repository, groups: [...part.groups] });
  }
  return sections;
}

/**
 * The request «Зафиксировать с агентом» puts into a chat composer (Stage 11
 * 1.G «Пересказ смысла»): the uncommitted groups of the window's area with
 * their facts and paths by repository, then the short rules. A sensitive
 * Collection is named only by its folder and file count. Messages are in
 * the interface language; the rule on message language names it.
 */
export function agentCommitRequest(
  sections: readonly GitUncommittedGroupsDto[],
): string {
  const lines: string[] = [m.agent_commit_request_intro()];
  for (const section of sections) {
    lines.push("", m.agent_commit_request_repository({ path: section.repository }));
    section.groups.forEach((group, index) => {
      lines.push(...groupLines(group, index + 1));
    });
  }
  lines.push(
    "",
    m.agent_commit_request_rules(),
    ...[
      m.agent_commit_request_rule_one_cause(),
      m.agent_commit_request_rule_no_mixing(),
      m.agent_commit_request_rule_explicit_paths(),
      m.agent_commit_request_rule_language(),
      m.agent_commit_request_rule_sensitive(),
      m.agent_commit_request_rule_no_agent(),
      m.agent_commit_request_rule_no_publish(),
    ].map((rule) => `- ${rule}`),
  );
  return lines.join("\n");
}

function groupLines(group: GitUncommittedGroupDto, number: number): string[] {
  const kind =
    group.kind === "system"
      ? m.agent_commit_request_kind_system()
      : group.kind === "structural"
        ? m.agent_commit_request_kind_structural()
        : null;
  const lines: string[] = [`${number}. ${group.header}${kind ? ` (${kind})` : ""}`];
  for (const fact of group.facts) lines.push(`   - ${fact}`);
  if (group.paths.length > 0) {
    lines.push(
      `   ${m.agent_commit_request_files({
        paths: group.paths.map((path) => `\`${path}\``).join(", "),
      })}`,
    );
  }
  for (const hidden of group.hidden) {
    lines.push(
      `   ${m.agent_commit_request_hidden({
        folder: `\`${hidden.folder}\``,
        count: String(hidden.files),
      })}`,
    );
  }
  return lines;
}
