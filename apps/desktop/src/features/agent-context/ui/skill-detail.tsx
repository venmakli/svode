import * as m from "@/paraglide/messages.js";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import { skillDetailProvenance } from "../model/detail-provenance";
import type { AgentContextSkillRow } from "../model/types";
import {
  AgentContextContentHealthNotice,
  AgentContextSourceDisclosure,
} from "./source-disclosure";
import { AgentContextSkillFrontmatterDisclosure } from "./skill-frontmatter-disclosure";

const skillReaderPolicy: MarkdownReaderPolicy = {
  openLink: () => undefined,
  resolveImageSource: () => null,
  resolveLink: () => null,
};

export function AgentContextSkillDetail({
  row,
}: {
  row: AgentContextSkillRow;
}) {
  const provenance = skillDetailProvenance(row);
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-skill-detail={row.id}
    >
      <AgentContextSourceDisclosure provenance={provenance} />
      <AgentContextSkillFrontmatterDisclosure row={row} />
      <AgentContextContentHealthNotice provenance={provenance} />
      <MarkdownReader content={row.body} policy={skillReaderPolicy} />
    </div>
  );
}

export function skillWarnings(row: AgentContextSkillRow): readonly string[] {
  if (row.health !== "degraded") return [];
  return row.healthReasons.length > 0
    ? Array.from(new Set(row.healthReasons))
    : [m.agent_context_health_degraded()];
}
