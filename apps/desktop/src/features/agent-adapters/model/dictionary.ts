import type { ColorName } from "@/features/properties";
import * as m from "@/paraglide/messages.js";

export interface AgentAdapterIdentity {
  id: string;
  displayName: string;
}

export interface AgentOption {
  name: string;
  color: ColorName;
}

/** The only place that colors agents; labels come from the adapter registry. */
const AGENT_COLORS: Readonly<Record<string, ColorName>> = {
  codex: "blue",
  "claude-code": "orange",
};

const FALLBACK_COLOR: ColorName = "neutral";

/** Agent names and colors by adapter id, for every place that shows an agent. */
export interface AgentAdapterDictionary {
  /** The registry labels have been read, or reading them failed. */
  ready: boolean;
  label(adapterId: string): string;
  color(adapterId: string): ColorName;
  /**
   * Select options of every registered agent, plus the neutral fallback when
   * one of `adapterIds` is not registered.
   */
  options(adapterIds?: Iterable<string>): AgentOption[];
}

export function createAgentAdapterDictionary(
  identities: readonly AgentAdapterIdentity[],
  ready = true,
): AgentAdapterDictionary {
  const labels = new Map(
    identities.map((identity) => [identity.id, identity.displayName]),
  );
  const label = (adapterId: string) =>
    labels.get(adapterId) ?? m.agent_adapter_unknown();
  const color = (adapterId: string) =>
    (labels.has(adapterId) && AGENT_COLORS[adapterId]) || FALLBACK_COLOR;

  return {
    ready,
    label,
    color,
    options(adapterIds = []) {
      const options: AgentOption[] = identities.map((identity) => ({
        name: identity.displayName,
        color: color(identity.id),
      }));
      for (const adapterId of adapterIds) {
        if (labels.has(adapterId)) continue;
        options.push({ name: label(adapterId), color: FALLBACK_COLOR });
        break;
      }
      return options;
    },
  };
}
