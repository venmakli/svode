import * as m from "@/paraglide/messages.js";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import type { CustomAgentSetupDto } from "../api";
import type { AgentRowAction, AgentRowView } from "../model/agent-row";
import { AgentRowFrame } from "./agent-row";

/**
 * A custom ACP agent the user added: its name, one state line, the menu
 * with Check, Edit… and Remove, and its switch. Turning it on installs
 * nothing, so the switch works at once.
 */
export function CustomAgentRow({
  setup,
  view,
  onToggle,
  onAction,
  onCheck,
  onEdit,
  onRemove,
}: {
  setup: CustomAgentSetupDto;
  view: AgentRowView;
  onToggle: (enabled: boolean) => void;
  onAction: (action: AgentRowAction) => void;
  onCheck: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const pending = view.state.kind === "pending";
  return (
    <AgentRowFrame
      agent={setup.agent}
      label={setup.name}
      version={null}
      view={view}
      menu={
        <>
          <DropdownMenuItem disabled={pending} onSelect={onCheck}>
            {m.settings_agents_check()}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={pending} onSelect={onEdit}>
            {m.settings_agents_custom_edit()}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={pending}
            onSelect={onRemove}
          >
            {m.settings_agents_custom_remove()}
          </DropdownMenuItem>
        </>
      }
      checked={setup.enabled}
      toggleDisabled={false}
      onToggle={onToggle}
      onAction={onAction}
    />
  );
}
