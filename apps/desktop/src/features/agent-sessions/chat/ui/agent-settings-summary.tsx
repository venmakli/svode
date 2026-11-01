import {
  AgentIcon,
  useAgentAdapterDictionary,
} from "@/features/agent-adapters";
import {
  currentOptionName,
  sessionControls,
  type SessionSetting,
} from "../model/session-controls";

/**
 * What an entry of the agent settings popover outside the composer names
 * (Stage 11 `03`, host differences): the agent, its model or else its name,
 * and in gray the reasoning level; `empty` while no agent is chosen.
 */
export function useAgentSettingsSummary(
  agent: string | null,
  settings: SessionSetting[] | null,
  empty: string,
) {
  const dictionary = useAgentAdapterDictionary();
  if (!agent) return { label: empty, reasoning: null, text: empty };
  const name = dictionary.label(agent);
  const controls = sessionControls(settings ?? []);
  const model = controls.model ? currentOptionName(controls.model) : null;
  const reasoning = controls.reasoning
    ? currentOptionName(controls.reasoning)
    : null;
  return {
    label: model ?? name,
    reasoning,
    /** The whole entry for an accessible name. */
    text: [name, model, reasoning].filter(Boolean).join(", "),
  };
}

/** The entry's content: the agent icon, the model and the reasoning. */
export function AgentSettingsSummary({
  agent,
  settings,
  empty,
}: {
  agent: string | null;
  settings: SessionSetting[] | null;
  /** Shown while no agent is chosen. */
  empty: string;
}) {
  const summary = useAgentSettingsSummary(agent, settings, empty);
  return (
    <>
      {agent && <AgentIcon agent={agent} />}
      <span className="truncate">{summary.label}</span>
      {summary.reasoning && (
        <span className="truncate text-muted-foreground">
          {summary.reasoning}
        </span>
      )}
    </>
  );
}
