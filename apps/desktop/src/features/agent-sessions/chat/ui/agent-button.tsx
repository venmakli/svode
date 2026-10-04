import { ChevronDown, RotateCw, Settings2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AgentIcon, useAgentAdapterDictionary } from "@/features/agent-adapters";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InputGroupButton } from "@/components/ui/input-group";
import type { AgentLaunchUnavailableDto } from "../api/chat";
import type { ChatAgent } from "../model/agents";
import type { DraftAgentState } from "../hooks/use-draft-agent";
import {
  currentOptionName,
  filterOptions,
  MODEL_SEARCH_FROM,
  sessionControls,
  type SessionSetting,
  type SettingValue,
} from "../model/session-controls";
import * as m from "@/paraglide/messages.js";

/** The A1 outcome of an agent that cannot start, in the words of the agent settings. */
export function unavailableText(reason: AgentLaunchUnavailableDto): string {
  switch (reason.code) {
    case "node_missing":
      return m.settings_agents_state_node_missing({
        required: String(reason.required),
      });
    case "node_unsupported":
      return m.settings_agents_state_node_unsupported({
        version: reason.version,
        required: String(reason.required),
      });
    case "node_unknown":
      return m.settings_agents_state_node_unknown();
    case "cli_unsupported":
      return m.settings_agents_state_cli_unsupported({
        minimum: reason.minimum,
      });
    case "adapter_not_installed":
      return m.settings_agents_state_adapter_missing();
    case "adapter_needs_update":
      return m.sessions_chat_agent_adapter_outdated();
    case "executable_missing":
      return m.settings_agents_state_command_missing({
        command: reason.executable,
      });
    case "disabled":
      return m.settings_agents_state_disabled();
    case "not_supported":
      return m.settings_agents_state_deferred();
  }
}

export interface AgentRecoveryActions {
  onSignIn: (() => void) | null;
  onOpenSettings: () => void;
  onRetry: () => void;
}

/** The agent tabs of a new session draft and the agent's readiness. */
export interface DraftAgentChoice {
  agents: ChatAgent[];
  onChoose: (agent: string) => void;
  readiness: DraftAgentState;
  recovery: AgentRecoveryActions;
  /**
   * The agent's settings show only after the first send: there is no
   * evidence that it creates a session without leaving it in its store.
   */
  settingsAfterSend: boolean;
}

/**
 * The agent and model button in the composer field (Stage 10 `04`,
 * composer): the agent's icon, the model and, in gray, the reasoning level.
 * Its popover holds the agent tabs in a draft or the session's agent after
 * the first send, then the model, reasoning and the agent's other settings,
 * each under its own label. Values show as the agent confirmed them.
 */
export function AgentModelButton({
  agent,
  draft,
  settings,
  canChange,
  changing,
  onChange,
}: {
  agent: string | null;
  /** Present in a new session draft only. */
  draft: DraftAgentChoice | null;
  /** The session's declared settings; null while they are not known yet. */
  settings: SessionSetting[] | null;
  /** The runtime drives the session, so its settings can change. */
  canChange: boolean;
  /** The setting whose change waits for the agent. */
  changing: string | null;
  onChange: (value: SettingValue) => void;
}) {
  const dictionary = useAgentAdapterDictionary();
  const [open, setOpen] = useState(false);
  const controls = sessionControls(settings ?? []);
  const name = agent ? dictionary.label(agent) : m.sessions_chat_agent_choose();
  const label = controls.model ? currentOptionName(controls.model) : name;
  const reasoning = controls.reasoning ? currentOptionName(controls.reasoning) : null;
  const change = (setting: SessionSetting, value: string) => {
    if (value && value !== setting.currentValue) {
      onChange({ setting: setting.id, value });
    }
  };
  const blockProps = { canChange, changing, onChange: change };
  return (
    // Modal: its own scroll lock lets the wheel scroll the model list in
    // the session peek, whose sheet locks scroll outside itself.
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
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
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-80 gap-0 p-0">
        <div className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] flex-col gap-3 overflow-y-auto p-3">
          {draft ? (
            <AgentTabs agent={agent} draft={draft} />
          ) : (
            agent && (
              <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
                <AgentIcon agent={agent} />
                <span className="truncate">{name}</span>
              </div>
            )
          )}
          <ModelBlock
            draft={draft}
            settings={settings}
            model={controls.model}
            {...blockProps}
          />
          {controls.reasoning && (
            <SettingBlock
              label={m.sessions_chat_reasoning_level()}
              setting={controls.reasoning}
              {...blockProps}
            />
          )}
          {controls.others.map((setting) => (
            <SettingBlock
              key={setting.id}
              label={setting.name}
              setting={setting}
              {...blockProps}
            />
          ))}
        </div>
        {draft && (
          <div className="border-t p-1">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                draft.recovery.onOpenSettings();
              }}
            >
              <Settings2 data-icon="inline-start" />
              {m.sessions_chat_agent_settings()}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AgentTabs({ agent, draft }: { agent: string | null; draft: DraftAgentChoice }) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={1}
      value={agent ?? ""}
      onValueChange={(next) => {
        if (next) draft.onChoose(next);
      }}
      aria-label={m.sessions_chat_agent_tabs()}
      className="flex-wrap justify-start"
    >
      {draft.agents.map((candidate) => (
        <Tooltip key={candidate.agent}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={candidate.agent}
              aria-label={candidate.name}
              className="size-8 px-0"
            >
              <AgentIcon agent={candidate.agent} />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{candidate.name}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" aria-label={label}>
      <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
      {children}
    </section>
  );
}

interface BlockProps {
  canChange: boolean;
  changing: string | null;
  onChange: (setting: SessionSetting, value: string) => void;
}

/**
 * "Model": the agent's models, with a search from five of them; while the
 * agent starts a skeleton, and in its place the agent's recovery or why
 * there is no choice.
 */
function ModelBlock({
  draft,
  settings,
  model,
  ...props
}: BlockProps & {
  draft: DraftAgentChoice | null;
  settings: SessionSetting[] | null;
  model: SessionSetting | null;
}) {
  const readiness = draft?.readiness;
  let content: ReactNode;
  if (readiness?.state === "idle") return null;
  if (
    readiness &&
    readiness.state !== "connecting" &&
    !(readiness.state === "checked" && readiness.check.state === "ready")
  ) {
    content = <AgentRecovery readiness={readiness} recovery={draft.recovery} />;
  } else if (readiness?.state === "connecting" || (settings === null && !draft?.settingsAfterSend)) {
    content = (
      <div className="flex flex-col gap-1.5" aria-busy="true">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  } else if (draft?.settingsAfterSend) {
    content = <Note>{m.sessions_chat_model_after_send()}</Note>;
  } else if (!model) {
    content = <Note>{m.sessions_chat_model_not_declared()}</Note>;
  } else {
    content = <OptionList setting={model} search={model.options.length >= MODEL_SEARCH_FROM} {...props} />;
  }
  return <Block label={m.sessions_chat_model()}>{content}</Block>;
}

/** Reasoning and the agent's other settings, under their label. */
function SettingBlock({
  label,
  setting,
  ...props
}: BlockProps & { label: string; setting: SessionSetting }) {
  return (
    <Block label={label}>
      {setting.options.length <= TOGGLE_OPTIONS ? (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={setting.currentValue}
          disabled={!props.canChange || props.changing === setting.id}
          onValueChange={(value) => props.onChange(setting, value)}
          aria-label={label}
          className="w-full"
        >
          {setting.options.map((option) => (
            <ToggleGroupItem
              key={option.value}
              value={option.value}
              title={option.description ?? undefined}
              className="min-w-0 flex-1"
            >
              <span className="truncate">{option.name}</span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <OptionList setting={setting} search={false} {...props} />
      )}
    </Block>
  );
}

/** A setting with few values is a toggle group across the popover. */
const TOGGLE_OPTIONS = 4;

function OptionList({
  setting,
  search,
  canChange,
  changing,
  onChange,
}: BlockProps & { setting: SessionSetting; search: boolean }) {
  const [query, setQuery] = useState("");
  const options = filterOptions(setting.options, query);
  const disabled = !canChange || changing === setting.id;
  return (
    <Command shouldFilter={false} className="rounded-lg! border p-0">
      {search && (
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder={m.sessions_chat_model_search()}
          aria-label={m.sessions_chat_model_search()}
        />
      )}
      <CommandList className="max-h-56">
        <CommandEmpty>{m.sessions_chat_model_search_empty()}</CommandEmpty>
        <CommandGroup>
          {options.map((option) => (
            <CommandItem
              key={option.value}
              value={option.value}
              disabled={disabled}
              data-checked={option.value === setting.currentValue}
              onSelect={() => onChange(setting, option.value)}
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{option.name}</span>
                {option.description && (
                  <span className="truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}

export function AgentRecovery({
  readiness,
  recovery,
}: {
  readiness: Exclude<DraftAgentState, { state: "idle" } | { state: "connecting" }>;
  recovery: AgentRecoveryActions;
}) {
  let text: string;
  let signIn = false;
  let retry = false;
  if (readiness.state === "failed") {
    text = m.settings_agents_state_failed_to_start({ message: readiness.message });
    retry = true;
  } else {
    const check = readiness.check;
    switch (check.state) {
      case "auth_required":
        text = m.settings_agents_state_sign_in();
        signIn = true;
        break;
      case "unavailable":
        text = unavailableText(check.reason);
        break;
      case "failed_to_start":
        text = m.settings_agents_state_failed_to_start({
          message: check.message,
        });
        retry = true;
        break;
      case "ready":
        return null;
    }
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm break-words">{text}</p>
      <div className="flex flex-wrap gap-2">
        {signIn && recovery.onSignIn && (
          <Button size="sm" onClick={recovery.onSignIn}>
            {m.settings_agents_action_sign_in()}
          </Button>
        )}
        {retry && (
          <Button size="sm" variant="outline" onClick={recovery.onRetry}>
            <RotateCw data-icon="inline-start" />
            {m.sessions_chat_agent_retry()}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={recovery.onOpenSettings}>
          {m.sessions_chat_agent_open_settings()}
        </Button>
      </div>
    </div>
  );
}
