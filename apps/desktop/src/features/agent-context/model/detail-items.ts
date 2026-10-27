import type { AgentContextItem } from "./types";

/** The rows of a plugin's «Компоненты», opened in the peek of the plugin. */
export function agentContextPluginComponentsKey(pluginId: string): string {
  return `agent-context-plugin:${pluginId}`;
}

/**
 * The current version of the item an open peek shows: a row of the
 * "Context" or a nested component of a plugin, under the instance of the
 * plugin's «Компоненты» when it was opened there; undefined once it is gone.
 */
export function findAgentContextDetailItem(
  items: readonly AgentContextItem[],
  instanceKey: string,
  selection: { instanceKey: string; rowId: string },
): AgentContextItem | undefined {
  if (selection.instanceKey === instanceKey) {
    for (const item of items) {
      if (item.id === selection.rowId) return item;
      const component = item.components.find(
        (candidate) => candidate.id === selection.rowId,
      );
      if (component) return component;
    }
    return undefined;
  }
  return items
    .find(
      (item) =>
        agentContextPluginComponentsKey(item.id) === selection.instanceKey,
    )
    ?.components.find((component) => component.id === selection.rowId);
}
