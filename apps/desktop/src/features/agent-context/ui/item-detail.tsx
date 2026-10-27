import { lazy, Suspense } from "react";
import { Braces } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

import {
  CollectionDetailHeader,
  type CollectionDetailContent,
  type CollectionDetailRowBinding,
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

import { agentContextMcpCommandText } from "../model/mcp-server";
import {
  skillMetadataObjectLines,
  sortedSkillMetadata,
  splitAllowedTools,
} from "../model/skill-frontmatter";
import type {
  AgentContextItem,
  AgentContextMcpFacts,
  AgentContextPluginManifest,
  AgentContextSkillFacts,
  AgentContextSkillMetadataValue,
} from "../model/types";
import { AgentContextArtifactOpenWith } from "./artifact-open-with";
import { AgentContextContentTruncatedNotice } from "./content-truncated-notice";
import { AgentContextItemInfo } from "./detail-info";
import { AgentContextItemTabs } from "./item-content-tabs";
import {
  AgentContextItemIcon,
  agentContextItemDescription,
} from "./item-properties";
import {
  AgentContextPluginCodeComponents,
  AgentContextPluginComponentsTab,
  pluginComponentCounts,
} from "./plugin-components-tab";

const itemReaderPolicy: MarkdownReaderPolicy = {};

// The Attachments mechanics load with the first open of a skill's files.
const AgentContextSkillFilesTab = lazy(async () => ({
  default: (await import("./skill-files-tab")).AgentContextSkillFilesTab,
}));

export interface AgentContextDetailOptions {
  /** Opens a plugin's components in the same peek, following the "Context". */
  detail: CollectionDetailRowBinding<AgentContextItem>;
  /** Opens App Settings "Providers", which manages the Svode integration. */
  onOpenProviders?: () => void;
}

/**
 * The peek of an item: identity, ⓘ and "Open with" in the top bar; the
 * panel shows every property but the name, which the identity already says.
 */
export function createAgentContextItemDetailContent(
  item: AgentContextItem,
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[],
  options: AgentContextDetailOptions,
): CollectionDetailContent {
  return {
    content: (
      <AgentContextItemDetail
        detail={options.detail}
        item={item}
        onOpenProviders={options.onOpenProviders}
        properties={properties.filter((property) => property.key !== "name")}
        tableProperties={properties}
      />
    ),
    description:
      item.kind === "instruction"
        ? m.agent_context_detail_description()
        : (agentContextItemDescription(item) ?? ""),
    identity: {
      icon: <AgentContextItemIcon item={item} />,
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

/**
 * A skill and a plugin have a page-like header and their content in tabs;
 * an instruction starts with its panel, and its text follows without tabs;
 * an MCP server ends with its panel.
 */
function AgentContextItemDetail({
  detail,
  item,
  onOpenProviders,
  properties,
  tableProperties,
}: {
  detail: CollectionDetailRowBinding<AgentContextItem>;
  item: AgentContextItem;
  onOpenProviders?: () => void;
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
  tableProperties: readonly CollectionPropertyDefinition<AgentContextItem>[];
}) {
  const factGroups: CollectionPropertyFactGroup[] = [];
  if (item.skill) factGroups.push(skillFrontmatterFacts(item.skill));
  if (item.plugin?.manifest) {
    factGroups.push(pluginManifestFacts(item.plugin.manifest));
  }
  if (item.mcp) factGroups.push(mcpServerFacts(item.mcp));
  if (item.managedBySvode && onOpenProviders) {
    factGroups.push(svodeIntegrationFacts(onOpenProviders));
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-item-detail={item.kind}
    >
      {item.kind !== "instruction" ? (
        <CollectionDetailHeader
          description={agentContextItemDescription(item)}
          icon={<AgentContextItemIcon item={item} />}
          title={item.name}
        />
      ) : null}
      <CollectionPropertyPanel
        factGroups={factGroups}
        properties={properties}
        row={item}
      />
      {item.kind === "plugin" ? (
        <AgentContextItemTabs
          key={item.id}
          tabs={[
            {
              content: item.plugin?.hasReadme ? (
                <div className="flex min-w-0 flex-col gap-4 px-6 pt-2">
                  <ItemBody item={item} />
                </div>
              ) : null,
              id: "description",
              label: m.agent_context_tab_description(),
            },
            {
              content: pluginComponentsContent(item, tableProperties, detail),
              id: "components",
              label: m.agent_context_tab_components(),
            },
          ]}
        />
      ) : item.kind === "skill" ? (
        <AgentContextItemTabs
          key={item.id}
          tabs={[
            {
              content: item.body.trim() ? (
                <div className="flex min-w-0 flex-col gap-4 px-6 pt-2">
                  <ItemBody item={item} />
                </div>
              ) : null,
              id: "skill",
              label: m.agent_context_tab_skill(),
            },
            {
              content: item.skill?.hasFiles ? (
                <Suspense fallback={<Skeleton className="mx-6 mt-2 h-24" />}>
                  <AgentContextSkillFilesTab item={item} />
                </Suspense>
              ) : null,
              id: "files",
              label: m.agent_context_tab_files(),
            },
          ]}
        />
      ) : item.kind === "instruction" ? (
        <ItemBody item={item} />
      ) : null}
    </div>
  );
}

function ItemBody({ item }: { item: AgentContextItem }) {
  return (
    <>
      <AgentContextContentTruncatedNotice truncated={item.truncated} />
      <MarkdownReader content={item.body} policy={itemReaderPolicy} />
    </>
  );
}

/**
 * The nested rows and counted kinds of a declared plugin, nothing when it
 * has none; the plugin whose code defines its components says so.
 */
function pluginComponentsContent(
  item: AgentContextItem,
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[],
  detail: CollectionDetailRowBinding<AgentContextItem>,
) {
  if (!item.plugin) return null;
  if (item.plugin.composition === "code") {
    return <AgentContextPluginCodeComponents />;
  }
  if (item.components.length === 0 && !pluginComponentCounts(item.plugin)) {
    return null;
  }
  return (
    <AgentContextPluginComponentsTab
      detail={detail}
      item={item}
      properties={properties}
    />
  );
}

/** The manifest fields of a plugin; absent values are not shown. */
export function pluginManifestFacts(
  manifest: AgentContextPluginManifest,
): CollectionPropertyFactGroup {
  return {
    facts: [
      {
        key: "version",
        label: m.agent_context_plugin_version(),
        value: { kind: "text", text: manifest.version },
      },
      {
        key: "author",
        label: m.agent_context_plugin_author(),
        value: { kind: "text", text: manifest.author },
      },
      {
        key: "license",
        label: m.agent_context_plugin_license(),
        value: { kind: "text", text: manifest.license },
      },
      {
        key: "homepage",
        label: m.agent_context_plugin_homepage(),
        value: { kind: "code", code: manifest.homepage },
      },
      {
        key: "repository",
        label: m.agent_context_plugin_repository(),
        value: { kind: "code", code: manifest.repository },
      },
      {
        key: "keywords",
        label: m.agent_context_plugin_keywords(),
        value: { items: manifest.keywords, kind: "list" },
      },
    ],
    key: "plugin-manifest",
    label: m.agent_context_plugin_facts_group({ file: manifest.file }),
  };
}

/**
 * The command with its arguments or the URL, in full; the local scope of
 * Claude Code says the server is only for this project.
 */
export function mcpServerFacts(
  mcp: AgentContextMcpFacts,
): CollectionPropertyFactGroup {
  return {
    facts: [
      mcp.command.length > 0
        ? {
            key: "command",
            label: m.agent_context_mcp_command(),
            value: {
              code: agentContextMcpCommandText(mcp.command),
              kind: "code",
            },
          }
        : {
            key: "url",
            label: m.agent_context_mcp_url(),
            value: { code: mcp.url, kind: "code" },
          },
      {
        key: "scope",
        label: m.agent_context_mcp_scope(),
        value: {
          kind: "text",
          text: mcp.projectOnly ? m.agent_context_mcp_project_only() : null,
        },
      },
    ],
    key: "mcp-server",
    label: m.agent_context_mcp_facts_group(),
  };
}

/** "Managed by Svode", leading to the Providers that manage it. */
function svodeIntegrationFacts(
  onOpenProviders: () => void,
): CollectionPropertyFactGroup {
  return {
    facts: [
      {
        key: "managed-by-svode",
        label: m.agent_context_managed_by_svode(),
        value: {
          kind: "link",
          label: m.agent_context_open_providers(),
          onSelect: onOpenProviders,
        },
      },
    ],
    key: "svode",
    label: "",
  };
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
