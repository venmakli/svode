import { Braces } from "lucide-react";

import {
  CollectionDetailHeader,
  type CollectionDetailContent,
} from "@/features/collection/app-shell";
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
  AgentContextItem,
  AgentContextSkillFacts,
  AgentContextSkillMetadataValue,
} from "../model/types";
import { AgentContextArtifactOpenWith } from "./artifact-open-with";
import { AgentContextContentTruncatedNotice } from "./content-truncated-notice";
import { AgentContextItemInfo } from "./detail-info";
import { AgentContextItemIcon } from "./item-properties";

const itemReaderPolicy: MarkdownReaderPolicy = {};

/**
 * The peek of an item: identity, ⓘ and "Open with" in the top bar; the
 * panel shows every property but the name, which the identity already says.
 */
export function createAgentContextItemDetailContent(
  item: AgentContextItem,
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[],
): CollectionDetailContent {
  return {
    content: (
      <AgentContextItemDetail
        item={item}
        properties={properties.filter((property) => property.key !== "name")}
      />
    ),
    description:
      item.kind === "skill"
        ? (item.description ?? "")
        : m.agent_context_detail_description(),
    identity: {
      icon: <AgentContextItemIcon kind={item.kind} />,
      name: item.name,
    },
    info: <AgentContextItemInfo item={item} />,
    openWith: (
      <AgentContextArtifactOpenWith
        canonicalArtifactPath={item.path}
        ownerRoot={item.ownerPath}
      />
    ),
    title: item.name,
  };
}

/** A skill has a page-like header; an instruction starts with its panel. */
function AgentContextItemDetail({
  item,
  properties,
}: {
  item: AgentContextItem;
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-item-detail={item.kind}
    >
      {item.kind === "skill" ? (
        <CollectionDetailHeader
          description={item.description}
          icon={<AgentContextItemIcon kind={item.kind} />}
          title={item.name}
        />
      ) : null}
      <CollectionPropertyPanel
        factGroups={item.skill ? [skillFrontmatterFacts(item.skill)] : []}
        properties={properties}
        row={item}
      />
      <AgentContextContentTruncatedNotice truncated={item.truncated} />
      <MarkdownReader content={item.body} policy={itemReaderPolicy} />
    </div>
  );
}

/** The optional frontmatter of `SKILL.md`; absent values are not shown. */
export function skillFrontmatterFacts(
  skill: AgentContextSkillFacts,
): CollectionPropertyFactGroup {
  return {
    facts: [
      {
        key: "license",
        label: m.agent_context_skill_parameter_license(),
        value: { kind: "text", text: skill.license },
      },
      {
        key: "compatibility",
        label: m.agent_context_skill_parameter_compatibility(),
        value: { kind: "text", text: skill.compatibility },
      },
      {
        key: "allowed-tools",
        label: m.agent_context_skill_parameter_allowed_tools(),
        value: {
          items: skill.allowedTools
            ? splitAllowedTools(skill.allowedTools)
            : [],
          kind: "list",
        },
      },
      ...sortedSkillMetadata(skill.metadata).map(([key, value]) => ({
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
