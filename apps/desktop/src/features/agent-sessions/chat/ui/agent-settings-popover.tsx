import { Loader2, Settings2 } from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
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
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { MultiPanePopover } from "@/shared/ui/multi-pane-popover";
import {
  OverflowTabStrip,
  type OverflowTab,
  type OverflowTabStripFocus,
} from "@/shared/ui/overflow-tab-strip";
import { SettingsRow, SettingsStaticRow } from "@/shared/ui/settings-row";
import type { DraftAgentState } from "../hooks/use-draft-agent";
import {
  currentOptionName,
  filterOptions,
  MODEL_SEARCH_FROM,
  sessionControls,
  type SessionSetting,
  type SettingValue,
} from "../model/session-controls";
import { AgentRecovery, type AgentRecoveryActions } from "./agent-recovery";
import * as m from "@/paraglide/messages.js";

/** An agent the popover offers as a tab. */
export interface AgentSettingsTab {
  agent: string;
  name: string;
}

/** The agent tabs of the popover and the chosen agent's readiness. */
export interface AgentSettingsChoice {
  agents: readonly AgentSettingsTab[];
  onChoose: (agent: string) => void;
  readiness: DraftAgentState;
  recovery: AgentRecoveryActions;
  /**
   * The agent's settings show only after the first send: it has no draft
   * session and nothing it declared is kept on this device.
   */
  settingsAfterSend: boolean;
  /** The settings come from the agent's last session (Stage 11 `03`). */
  recorded?: boolean;
  /** Settings whose options show after a session with the chosen model. */
  withoutVariants?: string[];
}

/**
 * A tab after the agent tabs that is not an agent, as "Member's agent" of a
 * binding: while it is chosen its content stands in place of the rows.
 */
export interface AgentSettingsExtraTab {
  label: string;
  icon: ReactNode;
  selected: boolean;
  onChoose: () => void;
  content: ReactNode;
}

type PopoverProps = ComponentProps<typeof MultiPanePopover>;

export interface AgentSettingsPopoverProps {
  /** The host's entry, as the composer's agent button. */
  trigger: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: PopoverProps["side"];
  align?: PopoverProps["align"];
  /** The chosen agent; null while none is chosen. */
  agent: string | null;
  /**
   * The agents to choose from as tabs; null shows the agent as a row
   * without a choice, as a session after its first send.
   */
  choice: AgentSettingsChoice | null;
  /**
   * Called once an agent tab is chosen, the chosen one again included: the
   * composer closes the popover here (DF-217). Without it the popover stays
   * open.
   */
  onAgentChosen?: () => void;
  /** A tab beside the agent tabs of `choice`. */
  extraTab?: AgentSettingsExtraTab;
  /** The agent's declared settings; null while they are not known yet. */
  settings: SessionSetting[] | null;
  /**
   * The model the session ran on, which the agent does not offer now: the
   * next turn runs on the agent's model (DF-171 R2).
   */
  unavailableModel?: string | null;
  /**
   * The agent's setting of category `mode` is the last row, under the
   * agent's own label; the composer shows it under the field instead.
   */
  modeRow?: boolean;
  /** The settings can change now; otherwise the rows only show them. */
  canChange: boolean;
  /** The setting whose change waits for the agent. */
  changing: string | null;
  onChange: (value: SettingValue) => void;
  /** "Configure agents…" at the bottom; without it there is none. */
  onConfigureAgents?: () => void;
  /** Where focus goes once the popover closes; back to the trigger by default. */
  onCloseAutoFocus?: PopoverProps["onCloseAutoFocus"];
  /** A press outside the popover, before it closes. */
  onPointerDownOutside?: PopoverProps["onPointerDownOutside"];
}

/** The main screen of the popover, or the screen of one setting's values. */
type AgentPane = "main" | `setting:${string}`;

/** A setting of the main screen under the label it shows with. */
interface SettingEntry {
  label: string;
  setting: SessionSetting;
}

/** The value of the extra tab among agent ids, which never start with a space. */
const EXTRA_TAB = " extra";

/**
 * The popover choosing an agent and its settings (Stage 11 `03`, DF-229):
 * the agent tabs or the agent's row, then a row of the model, reasoning and
 * each other setting the agent declared with its value, the mode last where
 * the host asks for it; a row opens the screen of the setting's values in
 * the same popover. Values show as the agent confirmed them. Actions that
 * lead away from the popover close it first (DF-217 R3).
 */
export function AgentSettingsPopover({
  trigger,
  open,
  onOpenChange,
  side,
  align,
  agent,
  choice: hostChoice,
  onAgentChosen,
  extraTab,
  settings,
  unavailableModel = null,
  modeRow = false,
  canChange,
  changing,
  onChange,
  onConfigureAgents,
  onCloseAutoFocus,
  onPointerDownOutside,
}: AgentSettingsPopoverProps) {
  const dictionary = useAgentAdapterDictionary();
  // An opened popover with tabs starts on the chosen one (DF-261).
  const agentTabsFocus = useRef<OverflowTabStripFocus | null>(null);
  const leading = (action: () => void) => (): void => {
    onOpenChange(false);
    action();
  };
  const signIn = hostChoice?.recovery.onSignIn ?? null;
  const choice: AgentSettingsChoice | null = hostChoice && {
    ...hostChoice,
    recovery: {
      onSignIn: signIn && leading(signIn),
      onOpenSettings: leading(hostChoice.recovery.onOpenSettings),
      onRetry: hostChoice.recovery.onRetry,
    },
  };
  const [pane, setPane] = useState<AgentPane>("main");
  // The row whose screen was open takes focus back on the main screen.
  const [returnTo, setReturnTo] = useState<string | null>(null);
  const controls = sessionControls(settings ?? []);
  const extraChosen = choice && extraTab?.selected ? extraTab : null;
  const name = extraChosen
    ? extraChosen.label
    : agent
      ? dictionary.label(agent)
      : m.sessions_chat_agent_choose();
  const entries: SettingEntry[] = extraChosen
    ? []
    : [
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
        ...(modeRow && controls.mode
          ? [{ label: controls.mode.name, setting: controls.mode }]
          : []),
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
  const screens = canChange
    ? entries.filter(
        ({ setting }) => !choice?.withoutVariants?.includes(setting.id),
      )
    : [];
  const shownPane = screens.some(
    ({ setting }) => pane === `setting:${setting.id}`,
  )
    ? pane
    : "main";
  const rows = (
    <SettingRows
      choice={choice}
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
      side={side}
      align={align}
      // One height for every screen: a long list of values scrolls inside
      // instead of stretching the popover to the window.
      className="max-h-[min(420px,var(--radix-popover-content-available-height))]"
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setPane("main");
          setReturnTo(null);
        }
        onOpenChange(next);
      }}
      onOpenAutoFocus={(event) => {
        // Once the popover's focus trap holds: a sheet's trap would take
        // focus back from a tab focused earlier.
        if (agentTabsFocus.current?.focus()) event.preventDefault();
      }}
      onPointerDownOutside={onPointerDownOutside}
      onCloseAutoFocus={onCloseAutoFocus}
      mainPane="main"
      pane={shownPane}
      onPaneChange={setPane}
      trigger={trigger}
      panes={[
        {
          id: "main",
          title: name,
          content: (
            <div className="flex flex-col p-1">
              {choice ? (
                <AgentTabs
                  agent={agent}
                  choice={choice}
                  extraTab={extraTab}
                  focusRef={agentTabsFocus}
                  onChosen={onAgentChosen}
                >
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
          footer: onConfigureAgents && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={leading(onConfigureAgents)}
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
 * The agents as tabs: arrows move between them, a click, Enter or Space
 * chooses one, which starts it (`04`, C1), the chosen one again included.
 * Another agent shows its icon, the chosen one its icon and name; agents
 * that do not fit wait under "more", as the views of a Collection do.
 */
function AgentTabs({
  agent,
  choice,
  extraTab,
  focusRef,
  onChosen,
  children,
}: {
  agent: string | null;
  choice: AgentSettingsChoice;
  extraTab: AgentSettingsExtraTab | undefined;
  /** Gives focus to the chosen agent, as the opened popover does. */
  focusRef: Ref<OverflowTabStripFocus>;
  onChosen: (() => void) | undefined;
  /** The rows of the chosen agent. */
  children: ReactNode;
}) {
  const tabs = useMemo<OverflowTab[]>(
    () => [
      ...choice.agents.map((candidate) => ({
        value: candidate.agent,
        label: candidate.name,
        icon: <AgentIcon agent={candidate.agent} />,
      })),
      ...(extraTab
        ? [{ value: EXTRA_TAB, label: extraTab.label, icon: extraTab.icon }]
        : []),
    ],
    [choice.agents, extraTab],
  );
  const value = extraTab?.selected ? EXTRA_TAB : (agent ?? "");
  const change = (next: string) => {
    if (next === EXTRA_TAB) extraTab?.onChoose();
    else choice.onChoose(next);
  };
  const chosen = onChosen
    ? (next: string) => {
        if (next !== EXTRA_TAB) onChosen();
      }
    : undefined;
  return (
    <Tabs
      value={value}
      onValueChange={change}
      activationMode="manual"
      className="gap-1"
    >
      <div className="flex px-1 pt-1">
        <OverflowTabStrip
          tabs={tabs}
          value={value}
          onValueChange={change}
          onTabChoose={chosen}
          moreLabel={m.sessions_chat_agent_more()}
          labelActiveOnly
          overflowActivationMode="manual"
          focusRef={focusRef}
          listLabel={m.sessions_chat_agent_tabs()}
          className="flex-1 justify-start"
        />
      </div>
      {value && (
        // The rows follow the tabs in the tab order without a stop of
        // their own.
        <TabsContent value={value} tabIndex={-1} className="flex flex-col">
          {value === EXTRA_TAB ? extraTab?.content : children}
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
  choice,
  settings,
  entries,
  unavailableModel,
  canChange,
  changing,
  returnTo,
  onOpen,
}: {
  choice: AgentSettingsChoice | null;
  settings: SessionSetting[] | null;
  entries: SettingEntry[];
  unavailableModel: string | null;
  canChange: boolean;
  changing: string | null;
  returnTo: string | null;
  onOpen: (setting: SessionSetting) => void;
}) {
  const readiness = choice?.readiness;
  if (readiness?.state === "idle") return null;
  if (
    readiness &&
    readiness.state !== "connecting" &&
    !(readiness.state === "checked" && readiness.check.state === "ready")
  ) {
    return (
      <div className="p-2">
        <AgentRecovery readiness={readiness} recovery={choice.recovery} />
      </div>
    );
  }
  if (
    readiness?.state === "connecting" ||
    (settings === null && !choice?.settingsAfterSend)
  ) {
    return (
      <div className="flex flex-col gap-1 p-1" aria-busy="true">
        <Skeleton className="h-7 w-full" />
        <Skeleton className="h-7 w-3/4" />
      </div>
    );
  }
  const row = ({ label, setting }: SettingEntry) =>
    choice?.withoutVariants?.includes(setting.id) ? (
      <div key={setting.id}>
        <SettingsStaticRow
          label={label}
          meta={m.sessions_chat_setting_agent_default()}
        />
        <p className="px-2 pb-1.5 text-xs text-muted-foreground">
          {m.sessions_chat_setting_variants_after_model()}
        </p>
      </div>
    ) : (
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
      {choice?.settingsAfterSend ? (
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
      {choice?.recorded && (
        <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
          {m.sessions_chat_settings_last_session()}
        </p>
      )}
    </>
  );
}

/**
 * "label — value ›": opens the setting's values; waits while the agent has
 * not confirmed a change, and only shows the value while the settings
 * cannot change.
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
