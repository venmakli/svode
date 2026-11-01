import type { AgentContextItem, AgentContextSkillFile } from "./types";

/** The items of a plugin's «Компоненты», opened in the peek of the plugin. */
export function agentContextPluginComponentsKey(pluginId: string): string {
  return `agent-context-plugin:${pluginId}`;
}

/** An item of the "Context" or a plugin's component, under its instance. */
export interface AgentContextItemSelection {
  instanceKey: string;
  itemId: string;
}

/**
 * What the peek of the "Context" shows: an item, or a file of a skill opened
 * in its place.
 */
export type AgentContextPeekTarget =
  | ({ kind: "item" } & AgentContextItemSelection)
  | {
      kind: "file";
      file: AgentContextSkillFile;
      skill: AgentContextItemSelection;
    };

export function agentContextPeekIdentity(
  target: AgentContextPeekTarget,
): string {
  return target.kind === "item"
    ? JSON.stringify(["item", target.instanceKey, target.itemId])
    : JSON.stringify([
        "file",
        target.skill.instanceKey,
        target.skill.itemId,
        target.file.path,
      ]);
}

/**
 * The current version of the item an open peek shows: an item of the
 * "Context" or a nested component of a plugin, under the instance of the
 * plugin's «Компоненты» when it was opened there; undefined once it is gone.
 */
export function findAgentContextDetailItem(
  items: readonly AgentContextItem[],
  instanceKey: string,
  selection: AgentContextItemSelection,
): AgentContextItem | undefined {
  if (selection.instanceKey === instanceKey) {
    for (const item of items) {
      if (item.id === selection.itemId) return item;
      const component = item.components.find(
        (candidate) => candidate.id === selection.itemId,
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
    ?.components.find((component) => component.id === selection.itemId);
}
