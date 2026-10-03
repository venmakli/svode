import type { ReactNode } from "react";
import { Ellipsis, LoaderCircle } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import type { AgentInfoDto, AgentSetupDto } from "../api";
import {
  agentDeferred,
  cliVersionLabel,
  enableBlocked,
  type AgentCliWarning,
  type AgentOperation,
  type AgentOperationError,
  type AgentRestriction,
  type AgentRowAction,
  type AgentRowState,
  type AgentRowView,
} from "../model/agent-row";
import { SettingsItem } from "./settings-layout";

function reason(error: AgentOperationError) {
  switch (error.code) {
    case "node_missing":
      return m.settings_agents_reason_node_missing({
        required: String(error.required ?? ""),
      });
    case "node_unsupported":
      return m.settings_agents_reason_node_unsupported({
        version: error.version ?? "",
        required: String(error.required ?? ""),
      });
    case "download":
      return m.settings_agents_reason_download();
    case "integrity":
      return m.settings_agents_reason_integrity({
        package: error.package ?? "",
      });
    default:
      return error.message;
  }
}

function pendingText(operation: AgentOperation) {
  switch (operation) {
    case "enable":
      return m.settings_agents_pending_enable();
    case "install":
      return m.settings_agents_pending_install();
    case "disable":
      return m.settings_agents_pending_disable();
    case "update":
      return m.settings_agents_pending_update();
    case "remove":
      return m.settings_agents_pending_remove();
    case "remove_custom":
      return m.settings_agents_pending_remove_custom();
    case "check":
    case "sign_in":
      return m.settings_agents_pending_check();
  }
}

function failedText(operation: AgentOperation, error: AgentOperationError) {
  const value = { reason: reason(error) };
  switch (operation) {
    case "install":
      return m.settings_agents_failed_install(value);
    case "update":
      return m.settings_agents_failed_update(value);
    case "remove":
      return m.settings_agents_failed_remove(value);
    case "remove_custom":
      return m.settings_agents_failed_remove_custom(value);
    case "enable":
    case "disable":
      return m.settings_agents_failed_toggle(value);
    case "check":
      return m.settings_agents_failed_check(value);
    case "sign_in":
      return m.settings_agents_failed_sign_in(value);
  }
}

/** What a custom agent declared, or the restriction of what it did not. */
export function declaredText(capabilities: AgentInfoDto["capabilities"]) {
  if (!capabilities.listSessions || !capabilities.loadSession)
    return m.settings_agents_new_session_only();
  const declared = [
    m.settings_agents_capability_list(),
    m.settings_agents_capability_history(),
  ];
  if (capabilities.resumeSession)
    declared.push(m.settings_agents_capability_resume());
  return m.settings_agents_declared({ capabilities: declared.join(", ") });
}

function restrictionText(restriction: AgentRestriction) {
  switch (restriction) {
    case "new_session_only":
      return m.settings_agents_state_new_session_only();
    case "external_sessions_unlisted":
      return m.settings_agents_restriction_external_sessions_unlisted();
    case "no_terminal_continuation":
      return m.settings_agents_restriction_no_terminal_continuation();
    case "no_permission_requests":
      return m.settings_agents_restriction_no_permission_requests();
    case "turn_errors_hidden":
      return m.settings_agents_restriction_turn_errors_hidden();
  }
}

export function stateText(state: AgentRowState) {
  switch (state.kind) {
    case "deferred":
      return m.settings_agents_state_deferred();
    case "pending":
      return pendingText(state.operation);
    case "failed":
      return failedText(state.operation, state.error);
    case "sign_in":
      return m.settings_agents_state_sign_in();
    case "node":
      switch (state.node.state) {
        case "missing":
          return m.settings_agents_state_node_missing({
            required: String(state.required),
          });
        case "unsupported":
          return m.settings_agents_state_node_unsupported({
            version: state.node.version,
            required: String(state.required),
          });
        case "unknown":
          return m.settings_agents_state_node_unknown();
      }
      break;
    case "cli_unsupported":
      return m.settings_agents_state_cli_unsupported({
        minimum: state.minimum,
      });
    case "adapter_missing":
      return m.settings_agents_state_adapter_missing();
    case "adapter_outdated":
      return m.settings_agents_state_adapter_outdated({
        version: state.version,
      });
    case "failed_to_start":
      return m.settings_agents_state_failed_to_start({
        message: state.message,
      });
    case "command_missing":
      return m.settings_agents_state_command_missing({
        command: state.command,
      });
    case "checked": {
      const checked =
        state.name && state.version
          ? m.settings_agents_state_checked_version({
              name: state.name,
              version: state.version,
            })
          : m.settings_agents_state_checked();
      return state.declared
        ? `${checked} · ${declaredText(state.declared)}`
        : checked;
    }
    case "limited":
      return restrictionText(state.restrictions[0]);
    case "disabled":
      return m.settings_agents_state_disabled();
    case "ready":
      return m.settings_agents_state_ready();
  }
}

function warningText(warning: AgentCliWarning) {
  return warning.kind === "untested"
    ? m.settings_agents_cli_untested({ version: warning.testedUpTo })
    : m.settings_agents_cli_unknown();
}

function actionText(action: AgentRowAction) {
  switch (action) {
    case "sign_in":
      return m.settings_agents_action_sign_in();
    case "update":
      return m.settings_agents_action_update();
    case "retry":
      return m.settings_agents_action_retry();
  }
}

// Something the user should act on reads as an attention line.
const ATTENTION = new Set<AgentRowState["kind"]>([
  "failed",
  "sign_in",
  "node",
  "cli_unsupported",
  "adapter_outdated",
  "failed_to_start",
  "command_missing",
]);

/**
 * One found agent: name and CLI version, one state line, one contextual
 * action, the menu and the switch. The row has no expandable details.
 */
export function AgentRow({
  setup,
  label,
  view,
  onToggle,
  onAction,
  onCheck,
  onRemoveAdapter,
}: {
  setup: AgentSetupDto;
  label: string;
  view: AgentRowView;
  onToggle: (enabled: boolean) => void;
  onAction: (action: AgentRowAction) => void;
  onCheck: () => void;
  onRemoveAdapter: () => void;
}) {
  const pending = view.state.kind === "pending";
  const deferred = agentDeferred(setup);
  const adapterInstalled =
    setup.adapter !== null && setup.adapter.install.state !== "not_installed";

  return (
    <AgentRowFrame
      agent={setup.agent}
      label={label}
      version={cliVersionLabel(setup)}
      view={view}
      menu={
        deferred ? null : (
          <>
            <DropdownMenuItem disabled={pending} onSelect={onCheck}>
              {m.settings_agents_check()}
            </DropdownMenuItem>
            {adapterInstalled ? (
              <DropdownMenuItem
                variant="destructive"
                disabled={pending}
                onSelect={onRemoveAdapter}
              >
                {m.settings_agents_remove_adapter()}
              </DropdownMenuItem>
            ) : null}
          </>
        )
      }
      checked={setup.enabled && !deferred}
      toggleDisabled={deferred || (!setup.enabled && enableBlocked(setup))}
      onToggle={onToggle}
      onAction={onAction}
    />
  );
}

/** The composition every agent row shares, built-in or custom. */
export function AgentRowFrame({
  agent,
  label,
  version,
  view,
  menu,
  checked,
  toggleDisabled,
  onToggle,
  onAction,
}: {
  agent: string;
  label: string;
  version: string | null;
  view: AgentRowView;
  /** Items of the ⋯ menu; none hides it. */
  menu: ReactNode;
  checked: boolean;
  toggleDisabled: boolean;
  onToggle: (enabled: boolean) => void;
  onAction: (action: AgentRowAction) => void;
}) {
  const { state, warning, action } = view;
  const pending = state.kind === "pending";

  return (
    <SettingsItem
      data-agent={agent}
      title={
        <>
          {label}
          {version ? (
            <span className="ml-2 font-normal text-muted-foreground">
              {version}
            </span>
          ) : null}
        </>
      }
      description={
        <span
          data-agent-state={state.kind}
          className={ATTENTION.has(state.kind) ? "text-destructive" : undefined}
        >
          {stateText(state)}
          {warning ? ` · ${warningText(warning)}` : null}
          {state.kind === "limited" && state.restrictions.length > 1 ? (
            <>
              {" · "}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="link" size="xs" className="h-auto p-0">
                    {m.settings_agents_restrictions_all()}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-80 text-sm">
                  <ul className="list-disc space-y-1 pl-4">
                    {state.restrictions.map((restriction) => (
                      <li key={restriction}>{restrictionText(restriction)}</li>
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </>
          ) : null}
        </span>
      }
      actions={
        <>
          {pending ? (
            <LoaderCircle
              aria-hidden
              className="size-4 animate-spin text-muted-foreground"
            />
          ) : null}
          {action ? (
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => onAction(action)}
            >
              {actionText(action)}
            </Button>
          ) : null}
          {menu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={m.settings_agents_menu({ agent: label })}
                >
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Switch
            checked={checked}
            disabled={toggleDisabled}
            aria-disabled={pending || undefined}
            aria-label={m.settings_agents_toggle({ agent: label })}
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onCheckedChange={(checked) => {
              if (!pending) onToggle(checked);
            }}
          />
        </>
      }
    />
  );
}
