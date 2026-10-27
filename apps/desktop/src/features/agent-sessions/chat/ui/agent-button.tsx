import { ChevronDown, Loader2, RotateCw, Settings2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AgentIcon,
  useAgentAdapterDictionary,
} from "@/features/agent-adapters";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { InputGroupButton } from "@/components/ui/input-group";
import { MultiPanePopover } from "@/shared/ui/multi-pane-popover";
import { SettingsRow, SettingsStaticRow } from "@/shared/ui/settings-row";
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

/** The main screen of the popover, or the screen of one setting's values. */
type AgentPane = "main" | `setting:${string}`;

/** A setting of the main screen under the label it shows with. */
interface SettingEntry {
  label: string;
  setting: SessionSetting;
}

/**
 * The agent and model button in the composer field (Stage 10 `04`,
 * composer): the agent's icon, the model and, in gray, the reasoning level.
 * Its popover holds the agent tabs in a draft or the session's agent after
 * the first send, then a row of the model, reasoning and each other setting
 * of the agent with its value; a row opens the screen of the setting's
 * values in the same popover (DF-229). Values show as the agent confirmed
 * them.
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
  draft: DraftAgentChoice | null;
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
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<AgentPane>("main");
  // The row whose screen was open takes focus back on the main screen.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const controls = sessionControls(settings ?? []);
  const name = agent ? dictionary.label(agent) : m.sessions_chat_agent_choose();
  const label = controls.model ? currentOptionName(controls.model) : name;
  const reasoning = controls.reasoning
    ? currentOptionName(controls.reasoning)
    : null;
  const entries: SettingEntry[] = [
    ...(controls.model
      ? [{ label: m.sessions_chat_model(), setting: controls.model }]
      : []),
    ...(controls.reasoning
      ? [
          {
            label: m.sessions_chat_reasoning_level(),
            setting: controls.reasoning,
          },
        ]
      : []),
    ...controls.others.map((setting) => ({ label: setting.name, setting })),
  ];
  const openSetting = (setting: SessionSetting) => {
    setReturnTo(setting.id);
    setPane(`setting:${setting.id}`);
  };
  const choose = (setting: SessionSetting, value: string) => {
    if (value !== setting.currentValue) {
      onChange({ setting: setting.id, value });
    }
    setPane("main");
  };
  // A screen whose setting is gone, as after another agent was chosen,
  // gives way to the main screen.
  const screens = canChange ? entries : [];
  const shownPane = screens.some(
    ({ setting }) => pane === `setting:${setting.id}`,
  )
    ? pane
    : "main";
  const rows = (
    <SettingRows
      draft={draft}
      settings={settings}
      entries={entries}
      unavailableModel={unavailableModel}
      canChange={canChange}
      changing={changing}
      returnTo={returnTo}
      onOpen={openSetting}
    />
  );
  return (
    <MultiPanePopover<AgentPane>
      // Modal: its own scroll lock lets the wheel scroll a list in the
      // session peek, whose sheet locks scroll outside itself.
      modal
      side="top"
      align="start"
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPane("main");
          setReturnTo(null);
        }
        setOpen(next);
      }}
      mainPane="main"
      pane={shownPane}
      onPaneChange={setPane}
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
      panes={[
        {
          id: "main",
          title: name,
          content: (
            <div className="flex flex-col p-1">
              {draft ? (
                <AgentTabs agent={agent} draft={draft}>
                  {rows}
                </AgentTabs>
              ) : (
                <>
                  {agent && (
                    <div className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm font-medium">
                      <AgentIcon agent={agent} />
                      <span className="truncate">{name}</span>
                    </div>
                  )}
                  {rows}
                </>
              )}
            </div>
          ),
          footer: draft && (
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
          ),
        },
        ...screens.map(({ label, setting }) => ({
          id: `setting:${setting.id}` as const,
          title: label,
          scrollsItself: true,
          content: (
            <SettingValues
              label={label}
              setting={setting}
              search={
                setting === controls.model &&
                setting.options.length >= MODEL_SEARCH_FROM
              }
              onChoose={(value) => choose(setting, value)}
            />
          ),
        })),
      ]}
    />
  );
}

/**
 * The agents of a draft as tabs: arrows move between them, a click, Enter
 * or Space chooses one, which starts it (`04`, C1).
 */
function AgentTabs({
  agent,
  draft,
  children,
}: {
  agent: string | null;
  draft: DraftAgentChoice;
  /** The rows of the chosen agent. */
  children: ReactNode;
}) {
  return (
    <Tabs
      value={agent ?? ""}
      onValueChange={draft.onChoose}
      activationMode="manual"
      className="gap-1"
    >
      <TabsList
        aria-label={m.sessions_chat_agent_tabs()}
        className="m-1 h-auto flex-wrap justify-start group-data-horizontal/tabs:h-auto"
      >
        {draft.agents.map((candidate) => (
          <Tooltip key={candidate.agent}>
            <TooltipTrigger asChild>
              <TabsTrigger
                value={candidate.agent}
                aria-label={candidate.name}
                className="h-7 flex-none px-2"
              >
                <AgentIcon agent={candidate.agent} />
              </TabsTrigger>
            </TooltipTrigger>
            <TooltipContent>{candidate.name}</TooltipContent>
          </Tooltip>
        ))}
      </TabsList>
      {agent && (
        // The rows follow the tabs in the tab order without a stop of
        // their own.
        <TabsContent value={agent} tabIndex={-1} className="flex flex-col">
          {children}
        </TabsContent>
      )}
    </Tabs>
  );
}

/**
 * The main screen's rows of the agent's settings with their values: while
 * the agent starts a skeleton, in their place the agent's recovery, and in
 * place of "Model" why there is no choice.
 */
function SettingRows({
  draft,
  settings,
  entries,
  unavailableModel,
  canChange,
  changing,
  returnTo,
  onOpen,
}: {
  draft: DraftAgentChoice | null;
  settings: SessionSetting[] | null;
  entries: SettingEntry[];
  unavailableModel: string | null;
  canChange: boolean;
  changing: string | null;
  returnTo: string | null;
  onOpen: (setting: SessionSetting) => void;
}) {
  const readiness = draft?.readiness;
  if (readiness?.state === "idle") return null;
  if (
    readiness &&
    readiness.state !== "connecting" &&
    !(readiness.state === "checked" && readiness.check.state === "ready")
  ) {
    return (
      <div className="p-2">
        <AgentRecovery readiness={readiness} recovery={draft.recovery} />
      </div>
    );
  }
  if (
    readiness?.state === "connecting" ||
    (settings === null && !draft?.settingsAfterSend)
  ) {
    return (
      <div className="flex flex-col gap-1 p-1" aria-busy="true">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  }
  const row = ({ label, setting }: SettingEntry) => (
    <SettingRow
      key={setting.id}
      label={label}
      setting={setting}
      canChange={canChange}
      waiting={changing === setting.id}
      autoFocus={returnTo === setting.id}
      onOpen={() => onOpen(setting)}
    />
  );
  const model = entries[0]?.setting.category === "model" ? entries[0] : null;
  const rest = model ? entries.slice(1) : entries;
  return (
    <>
      {draft?.settingsAfterSend ? (
        <Note>{m.sessions_chat_model_after_send()}</Note>
      ) : model ? (
        row(model)
      ) : (
        <Note>{m.sessions_chat_model_not_declared()}</Note>
      )}
      {unavailableModel && (
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          {m.sessions_chat_model_session_unavailable({
            model: unavailableModel,
          })}
        </p>
      )}
      {rest.map(row)}
    </>
  );
}

/**
 * "label — value ›": opens the setting's values; waits while the agent has
 * not confirmed a change, and only shows the value while the runtime does
 * not drive the session.
 */
function SettingRow({
  label,
  setting,
  canChange,
  waiting,
  autoFocus,
  onOpen,
}: {
  label: string;
  setting: SessionSetting;
  canChange: boolean;
  waiting: boolean;
  autoFocus: boolean;
  onOpen: () => void;
}) {
  const value = currentOptionName(setting);
  if (!canChange) return <SettingsStaticRow label={label} meta={value} />;
  return (
    <SettingsRow
      label={label}
      meta={value}
      pending={waiting}
      right={
        waiting ? (
          <Loader2 className="animate-spin text-muted-foreground" />
        ) : undefined
      }
      autoFocus={autoFocus}
      onClick={onOpen}
    />
  );
}

/**
 * The screen of a setting's values: each with the agent's full
 * description, the confirmed one checked and highlighted first; the model
 * has a search from five models.
 */
function SettingValues({
  label,
  setting,
  search,
  onChoose,
}: {
  label: string;
  setting: SessionSetting;
  search: boolean;
  onChoose: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(setting.currentValue);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Without a search the list takes the keys itself.
    if (!search) root.current?.focus();
  }, [search]);
  const options = filterOptions(setting.options, query);
  return (
    <Command
      ref={root}
      tabIndex={-1}
      shouldFilter={false}
      value={highlighted}
      onValueChange={setHighlighted}
      label={label}
      className="h-auto min-h-0 rounded-none! bg-transparent p-0 outline-none"
    >
      {search && (
        <CommandInput
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder={m.sessions_chat_model_search()}
          aria-label={m.sessions_chat_model_search()}
        />
      )}
      <CommandList className="max-h-none min-h-0 p-1">
        <CommandEmpty>{m.sessions_chat_model_search_empty()}</CommandEmpty>
        {options.map((option) => (
          <CommandItem
            key={option.value}
            value={option.value}
            data-checked={option.value === setting.currentValue}
            onSelect={() => onChoose(option.value)}
            className="items-start"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="break-words">{option.name}</span>
              {option.description && (
                <span className="text-xs break-words text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{children}</p>
  );
}

export function AgentRecovery({
  readiness,
  recovery,
}: {
  readiness: Exclude<
    DraftAgentState,
    { state: "idle" } | { state: "connecting" }
  >;
  recovery: AgentRecoveryActions;
}) {
  let text: string;
  let signIn = false;
  let retry = false;
  if (readiness.state === "failed") {
    text = m.settings_agents_state_failed_to_start({
      message: readiness.message,
    });
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
