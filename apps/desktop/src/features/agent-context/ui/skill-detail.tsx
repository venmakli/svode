import { Braces, Sparkles } from "lucide-react";

import { CollectionDetailHeader } from "@/features/collection/app-shell";
import {
  CollectionPropertyPanel,
  type CollectionPropertyFactGroup,
  type CollectionPropertyFactValue,
} from "@/features/properties/panel";
import type { CollectionPropertyDefinition } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import {
  skillMetadataObjectLines,
  sortedSkillMetadata,
  splitAllowedTools,
} from "../model/skill-frontmatter";
import type {
  AgentContextSkillMetadataValue,
  AgentContextSkillRow,
} from "../model/types";
import { AgentContextContentTruncatedNotice } from "./content-truncated-notice";

const skillReaderPolicy: MarkdownReaderPolicy = {};

export function AgentContextSkillDetail({
  properties,
  row,
}: {
  properties: readonly CollectionPropertyDefinition<AgentContextSkillRow>[];
  row: AgentContextSkillRow;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-skill-detail={row.id}
    >
      <CollectionDetailHeader
        description={row.description}
        icon={<Sparkles />}
        title={row.name}
      />
      <CollectionPropertyPanel
        factGroups={[skillFrontmatterFacts(row)]}
        properties={properties}
        row={row}
      />
      <AgentContextContentTruncatedNotice truncated={row.truncated} />
      <MarkdownReader content={row.body} policy={skillReaderPolicy} />
    </div>
  );
}

/** The optional frontmatter of `SKILL.md`; absent values are not shown. */
export function skillFrontmatterFacts(
  row: AgentContextSkillRow,
): CollectionPropertyFactGroup {
  return {
    facts: [
      {
        key: "license",
        label: m.agent_context_skill_parameter_license(),
        value: { kind: "text", text: row.license },
      },
      {
        key: "compatibility",
        label: m.agent_context_skill_parameter_compatibility(),
        value: { kind: "text", text: row.compatibility },
      },
      {
        key: "allowed-tools",
        label: m.agent_context_skill_parameter_allowed_tools(),
        value: {
          items: row.allowedTools ? splitAllowedTools(row.allowedTools) : [],
          kind: "list",
        },
      },
      ...sortedSkillMetadata(row.metadata).map(([key, value]) => ({
        key: `metadata:${key}`,
        ...(value.kind === "object" ? { icon: Braces } : {}),
        label: key,
        value: metadataFactValue(value),
      })),
    ],
    key: "skill-md",
    label: m.agent_context_skill_facts_group(),
  };
}

/** Scalar — text, list of scalars — chips, object — monospace lines. */
function metadataFactValue(
  value: AgentContextSkillMetadataValue,
): CollectionPropertyFactValue {
  if (value.kind === "text") return { kind: "text", text: value.text };
  if (value.kind === "list") return { items: value.items, kind: "list" };
  return { code: skillMetadataObjectLines(value), kind: "code" };
}
