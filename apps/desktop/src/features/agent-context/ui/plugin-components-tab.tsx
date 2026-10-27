import { useMemo } from "react";

import {
  CollectionHost,
  useCollectionState,
  type CollectionInstance,
} from "@/features/collection";
import type { CollectionDetailRowBinding } from "@/features/collection/app-shell";
import type { CollectionPropertyDefinition } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

import { agentContextPluginComponentsKey } from "../model/detail-items";
import type {
  AgentContextItem,
  AgentContextPluginComponentKind,
  AgentContextPluginFacts,
} from "../model/types";
import { createAgentContextPresentation } from "./context-presentations";

/**
 * A plugin's «Компоненты»: its nested rows in the Table of "All", each
 * opening in the same peek, and one line with the number of each kind that
 * is no row. A plugin whose code defines its components says so instead.
 */
export function AgentContextPluginComponentsTab({
  detail,
  item,
  properties,
}: {
  detail: CollectionDetailRowBinding<AgentContextItem>;
  item: AgentContextItem;
  properties: readonly CollectionPropertyDefinition<AgentContextItem>[];
}) {
  const instanceKey = agentContextPluginComponentsKey(item.id);
  const presentation = useMemo(
    () =>
      createAgentContextPresentation({
        id: "all",
        onActivate: detail.activation({
          instanceKey,
          presentationId: "components",
        }),
        properties,
        state: { phase: "ready", rows: item.components },
      }),
    [detail, instanceKey, item.components, properties],
  );
  const instance = useMemo<CollectionInstance>(
    () => ({
      defaultPresentationId: "all",
      instanceKey,
      presentations: [presentation],
      stateScope: "session",
    }),
    [instanceKey, presentation],
  );
  const collectionState = useCollectionState(instance);
  const counts = item.plugin ? pluginComponentCounts(item.plugin) : "";

  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-agent-context-plugin-components
    >
      {item.components.length > 0 && collectionState.phase === "ready" ? (
        <CollectionHost instance={instance} state={collectionState} />
      ) : null}
      {counts ? (
        <p
          className="px-6 text-sm text-muted-foreground"
          data-agent-context-plugin-counts
        >
          {item.components.length > 0
            ? m.agent_context_components_other({ counts })
            : counts}
        </p>
      ) : null}
    </div>
  );
}

/** The tab of a plugin whose code registers what it brings. */
export function AgentContextPluginCodeComponents() {
  return (
    <p
      className="px-6 pt-2 text-sm text-muted-foreground"
      data-agent-context-plugin-code
    >
      {m.agent_context_components_code()}
    </p>
  );
}

const componentKindLabels: Readonly<
  Record<AgentContextPluginComponentKind, () => string>
> = {
  commands: m.agent_context_component_commands,
  executables: m.agent_context_component_executables,
  hooks: m.agent_context_component_hooks,
  lsp_servers: m.agent_context_component_lsp_servers,
  rules: m.agent_context_component_rules,
  subagents: m.agent_context_component_subagents,
  themes: m.agent_context_component_themes,
};

/** "commands: 3 · hooks: 2", empty when the plugin has none. */
export function pluginComponentCounts(plugin: AgentContextPluginFacts) {
  return plugin.counts
    .filter((count) => count.count > 0)
    .map((count) =>
      m.agent_context_component_count({
        count: count.count,
        kind: componentKindLabels[count.kind](),
      }),
    )
    .join(" · ");
}
