import { ChevronDown } from "lucide-react";
import { useState } from "react";
import {
  AgentIcon,
  useAgentAdapterDictionary,
} from "@/features/agent-adapters";
import { InputGroupButton } from "@/components/ui/input-group";
import { useComposerField } from "../hooks/use-composer-focus";
import {
  currentOptionName,
  sessionControls,
  type SessionSetting,
  type SettingValue,
} from "../model/session-controls";
import {
  AgentSettingsPopover,
  type AgentSettingsChoice,
} from "./agent-settings-popover";
import * as m from "@/paraglide/messages.js";

/**
 * The agent and model button in the composer field (Stage 10 `04`,
 * composer): the agent's icon, the model and, in gray, the reasoning level.
 * It opens the agent settings popover over the field: the agent tabs in a
 * draft, closing once an agent is chosen, and "Configure agents…"; the
 * session's agent after the first send; the permission mode stays under
 * the field.
 */
export function AgentModelButton({
  agent,
  draft,
  settings,
  unavailableModel = null,
  canChange,
  changing,
  onChange,
}: {
  agent: string | null;
  /** Present in a new session draft only. */
  draft: AgentSettingsChoice | null;
  /** The session's declared settings; null while they are not known yet. */
  settings: SessionSetting[] | null;
  /**
   * The model the session ran on, which the agent does not offer now: the
   * next turn runs on the agent's model (DF-171 R2).
   */
  unavailableModel?: string | null;
  /** The runtime drives the session, so its settings can change. */
  canChange: boolean;
  /** The setting whose change waits for the agent. */
  changing: string | null;
  onChange: (value: SettingValue) => void;
}) {
  const dictionary = useAgentAdapterDictionary();
  const field = useComposerField();
  const [open, setOpen] = useState(false);
  // The popover closes for a chosen agent or a click in the composer field
  // and gives focus to the field rather than the button (DF-217).
  const [focusField, setFocusField] = useState(false);
  const controls = sessionControls(settings ?? []);
  const name = agent ? dictionary.label(agent) : m.sessions_chat_agent_choose();
  const label = controls.model ? currentOptionName(controls.model) : name;
  const reasoning = controls.reasoning
    ? currentOptionName(controls.reasoning)
    : null;
  return (
    <AgentSettingsPopover
      side="top"
      align="start"
      open={open}
      onOpenChange={(next) => {
        if (next) setFocusField(false);
        setOpen(next);
      }}
      agent={agent}
      choice={draft}
      onAgentChosen={() => {
        setFocusField(true);
        setOpen(false);
      }}
      settings={settings}
      unavailableModel={unavailableModel}
      canChange={canChange}
      changing={changing}
      onChange={onChange}
      onConfigureAgents={draft?.recovery.onOpenSettings}
      onPointerDownOutside={(event) => {
        // The modal layer hides the field from the press, so its point
        // tells whether it is in the field.
        const press = event.detail.originalEvent;
        setFocusField(
          press.button === 0 &&
            !press.ctrlKey &&
            field?.contains(press.clientX, press.clientY) === true,
        );
      }}
      onCloseAutoFocus={(event) => {
        if (!focusField || !field) return;
        event.preventDefault();
        field.focus();
      }}
      trigger={
        <InputGroupButton
          size="sm"
          className="max-w-64 min-w-0 gap-1.5 px-2"
          aria-label={m.sessions_chat_agent_button({
            agent: [name, controls.model && label, reasoning]
              .filter(Boolean)
              .join(", "),
          })}
        >
          {agent && <AgentIcon agent={agent} />}
          <span className="truncate">{label}</span>
          {reasoning && (
            <span className="truncate text-muted-foreground @max-md/composer:hidden">
              {reasoning}
            </span>
          )}
          <ChevronDown className="text-muted-foreground" />
        </InputGroupButton>
      }
    />
  );
}
