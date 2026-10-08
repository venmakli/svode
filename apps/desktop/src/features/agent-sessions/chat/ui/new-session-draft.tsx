import { useState, type ReactNode } from "react";
import {
  Box,
  Check,
  ChevronDown,
  FolderClosed,
  SquareTerminal,
} from "lucide-react";
import { toast } from "sonner";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { AgentSignInDialog } from "@/features/settings/agent-sign-in";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getNativeErrorMessage } from "@/platform/native/errors";
import { useAgentSessionScopes } from "../../hooks/use-agent-session-scopes";
import type {
  AgentSessionScopeGroup,
  DraftSpaceChoice,
  DraftSpaceChoices,
} from "../../model";
import { signInAgent } from "../api/chat";
import {
  useNewSessionDraft,
  type DraftRefusal,
  type StartedSession,
} from "../hooks/use-new-session-draft";
import type { DraftAgentState } from "../hooks/use-draft-agent";
import { sessionControls } from "../model/session-controls";
import {
  AgentModelButton,
  AgentRecovery,
  unavailableText,
} from "./agent-button";
import { ChatDropSurface } from "./chat-drop-surface";
import { Composer } from "./composer";
import { ComposerFooter } from "./session-chat";
import {
  ContextIndicator,
  ModeSelect,
  SettingRefusalLine,
} from "./session-controls";
import * as m from "@/paraglide/messages.js";

/** Built-in agents have their own sign-in command; custom agents do not. */
const CUSTOM_PREFIX = "custom-";

/**
 * The draft of a new session (Stage 10 `04`, new session): the agent in
 * the composer's agent button, the Space under the field, and the
 * composer. Nothing exists until the first send creates the session, which
 * the same host then shows.
 */
export function NewSessionDraft({
  spacePath,
  onStarted,
  onOpenTerminal,
  onOpenAgentSettings,
  actions,
  spaceChoices,
}: {
  /** The Space of the context the draft was opened from. */
  spacePath: string;
  /** Places to list instead of the Spaces of the active project. */
  spaceChoices?: DraftSpaceChoices;
  onStarted: (started: StartedSession) => void;
  /** "New session in terminal": a managed terminal in the draft's Space. */
  onOpenTerminal: (spacePath: string) => void;
  onOpenAgentSettings: () => void;
  /** Host chrome next to the title, such as close or expand. */
  actions?: ReactNode;
}) {
  const draft = useNewSessionDraft(spacePath, onStarted);
  const dictionary = useAgentAdapterDictionary();
  const scopes = useAgentSessionScopes();
  const [signIn, setSignIn] = useState<{ agent: string; ptyId: string } | null>(
    null,
  );
  const readiness = draft.readiness;
  const ready =
    readiness.state === "checked" && readiness.check.state === "ready";
  const agent = draft.agent;

  const startSignIn =
    agent && !agent.startsWith(CUSTOM_PREFIX)
      ? () => {
          void signInAgent(agent)
            .then((terminal) => setSignIn({ agent, ptyId: terminal.ptyId }))
            .catch((error: unknown) => {
              toast.error(m.sessions_chat_sign_in_failed(), {
                description: getNativeErrorMessage(error),
              });
            });
        }
      : null;
  const recovery = {
    onSignIn: startSignIn,
    onOpenSettings: onOpenAgentSettings,
    onRetry: draft.retryAgent,
  };
  const noAgents = draft.agents !== null && draft.agents.agents.length === 0;
  const snapshot = draft.snapshot;
  const mode = snapshot ? sessionControls(snapshot.settings).mode : null;
  const canChange = snapshot?.writer === "acp" && !draft.sending;
  const changeSetting = (value: Parameters<typeof draft.changeSetting>[0]) =>
    void draft.changeSetting(value);

  return (
    <ChatDropSurface
      refusal={
        noAgents
          ? m.sessions_chat_no_agents()
          : draft.sending
            ? m.sessions_chat_sending()
            : null
      }
      className="flex h-full min-h-0 flex-col"
    >
      <header className="flex shrink-0 items-center gap-2 px-6 pb-3">
        <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
          {m.sessions_new_title()}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onOpenTerminal(draft.spacePath)}
        >
          <SquareTerminal data-icon="inline-start" />
          {m.sessions_chat_new_in_terminal()}
        </Button>
        {actions}
      </header>
      <div className="min-h-0 flex-1" />
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-1.5 px-6 pt-2">
        {noAgents ? (
          <NoChatAgents onOpenSettings={onOpenAgentSettings} />
        ) : (
          <>
            <ReadinessLine readiness={readiness} recovery={recovery} />
            {draft.settingRefusal && (
              <SettingRefusalLine
                refusal={draft.settingRefusal}
                settings={snapshot?.settings ?? []}
              />
            )}
            {draft.refusal && (
              <DraftRefusalLine
                refusal={draft.refusal}
                onSignIn={startSignIn}
                onOpenSettings={onOpenAgentSettings}
              />
            )}
            {draft.draft.notSent && (
              <p className="text-xs text-destructive">
                {m.sessions_chat_not_sent()}
              </p>
            )}
            <Composer
              draftKey={draft.draftKey}
              parts={draft.draft.parts}
              onPartsChange={draft.setParts}
              onSend={() => void draft.send()}
              onStop={() => undefined}
              running={false}
              cancelling={false}
              sending={draft.sending}
              canSend={ready && !draft.changingSetting}
              commands={snapshot?.commands}
              autoFocus
              placeholder={
                agent
                  ? m.sessions_chat_placeholder_new({
                      agent: dictionary.label(agent),
                    })
                  : m.sessions_chat_placeholder_continue()
              }
              controls={
                draft.agents && (
                  <AgentModelButton
                    agent={agent}
                    draft={{
                      agents: draft.agents.agents,
                      onChoose: draft.chooseAgent,
                      readiness,
                      recovery,
                      settingsAfterSend: draft.settingsAfterSend,
                    }}
                    settings={snapshot?.settings ?? null}
                    canChange={canChange}
                    changing={draft.changingSetting}
                    onChange={changeSetting}
                  />
                )
              }
            />
          </>
        )}
        <ComposerFooter>
          <SpaceSelect
            choices={spaceChoices?.choices ?? scopes.map(scopeChoice)}
            spacePath={draft.spacePath}
            disabled={draft.sending}
            onChoose={(path) => {
              if (!spaceChoices) {
                draft.chooseSpace(path);
                return;
              }
              void spaceChoices.choose(path).then((moved) => {
                if (moved) draft.chooseSpace(path);
              });
            }}
          />
          <div className="ms-auto flex min-w-0 items-center gap-1">
            {readiness.state === "connecting" && (
              <span>{m.sessions_chat_agent_connecting()}</span>
            )}
            {mode && (
              <ModeSelect
                mode={mode}
                canChange={canChange}
                changing={draft.changingSetting === mode.id}
                onChange={changeSetting}
              />
            )}
            <ContextIndicator usage={snapshot?.usage ?? null} />
          </div>
        </ComposerFooter>
      </div>
      {signIn && (
        <AgentSignInDialog
          agent={dictionary.label(signIn.agent)}
          ptyId={signIn.ptyId}
          onSignedIn={draft.recheckAgent}
          onClose={() => {
            setSignIn(null);
            draft.recheckAgent();
          }}
        />
      )}
    </ChatDropSurface>
  );
}

/** The chosen agent cannot start: the draft says why and how to recover. */
function ReadinessLine({
  readiness,
  recovery,
}: {
  readiness: DraftAgentState;
  recovery: Parameters<typeof AgentRecovery>[0]["recovery"];
}) {
  if (readiness.state === "idle" || readiness.state === "connecting")
    return null;
  if (readiness.state === "checked" && readiness.check.state === "ready")
    return null;
  return (
    <div className="rounded-lg border px-3 py-2">
      <AgentRecovery readiness={readiness} recovery={recovery} />
    </div>
  );
}

function DraftRefusalLine({
  refusal,
  onSignIn,
  onOpenSettings,
}: {
  refusal: DraftRefusal;
  onSignIn: (() => void) | null;
  onOpenSettings: () => void;
}) {
  if (refusal.kind === "unavailable") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        <span>{unavailableText(refusal.reason)}</span>
        <Button size="xs" variant="outline" onClick={onOpenSettings}>
          {m.sessions_chat_agent_open_settings()}
        </Button>
      </div>
    );
  }
  if (refusal.code === "auth_required") {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-destructive">
        <span>{m.sessions_chat_refusal_auth()}</span>
        {onSignIn && (
          <Button size="xs" onClick={onSignIn}>
            {m.settings_agents_action_sign_in()}
          </Button>
        )}
        <Button size="xs" variant="outline" onClick={onOpenSettings}>
          {m.sessions_chat_agent_open_settings()}
        </Button>
      </div>
    );
  }
  return (
    <p className="text-xs break-words text-destructive">
      {refusal.code === "file_unavailable"
        ? m.sessions_chat_refusal_file_unavailable()
        : m.sessions_chat_refusal_other({ message: refusal.message })}
    </p>
  );
}

function NoChatAgents({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-lg border px-3 py-2 text-sm">
      <p>{m.sessions_chat_no_agents()}</p>
      <Button size="sm" variant="outline" onClick={onOpenSettings}>
        {m.sessions_chat_agent_open_settings()}
      </Button>
    </div>
  );
}

function scopeChoice(scope: AgentSessionScopeGroup): DraftSpaceChoice {
  return {
    path: scope.path,
    name: scope.name,
    icon: scope.icon,
    kind: scope.kind,
    unavailable: scope.status === "ready" ? null : "",
  };
}

function SpaceSelect({
  choices,
  spacePath,
  disabled,
  onChoose,
}: {
  choices: DraftSpaceChoice[];
  spacePath: string;
  disabled: boolean;
  onChoose: (path: string) => void;
}) {
  const current = choices.find((choice) => choice.path === spacePath);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="-ms-1.5 max-w-64 text-muted-foreground"
          aria-label={m.sessions_chat_space_choose()}
        >
          {current && <ChoiceIcon choice={current} />}
          <span className="truncate">{current?.name ?? spacePath}</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        className="max-h-72 min-w-56"
      >
        {choices.map((choice) => (
          <DropdownMenuItem
            key={choice.path}
            disabled={choice.unavailable !== null}
            onSelect={() => onChoose(choice.path)}
          >
            <ChoiceIcon choice={choice} />
            <span className="min-w-0 flex-1 truncate">{choice.name}</span>
            {choice.unavailable && (
              <span className="shrink-0 text-xs text-muted-foreground">
                {choice.unavailable}
              </span>
            )}
            {choice.path === spacePath && <Check />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChoiceIcon({ choice }: { choice: DraftSpaceChoice }) {
  if (choice.icon) {
    return (
      <span className="flex size-4 items-center justify-center text-sm leading-none">
        {choice.icon}
      </span>
    );
  }
  return choice.kind === "project" ? <Box /> : <FolderClosed />;
}
