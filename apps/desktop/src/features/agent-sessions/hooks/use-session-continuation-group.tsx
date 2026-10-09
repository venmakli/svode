import { useCallback, useMemo, type ReactNode } from "react";
import { Copy, MessagesSquare, SquareTerminal } from "lucide-react";
import { toast } from "sonner";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import {
  ExternalAppIcon,
  useExternalOpen,
  type ExternalOpenTarget,
  type OpenWithAction,
  type OpenWithGroup,
} from "@/features/external-open";
import * as m from "@/paraglide/messages.js";
import { getNativeErrorMessage } from "@/platform/native/errors";

import {
  listExternalTerminalApps,
  openSessionCwdInExternalTerminal,
} from "../api";
import {
  primaryContinuation,
  SESSION_CONTINUATION_PREFERENCE_KEY,
} from "../chat/model/continuation";
import {
  openInChatAvailability,
  type TerminalActionAvailability,
} from "../chat/model/interface";
import type { AgentSession } from "../model";

/**
 * The continuation group of a session's "Open with": the chat and the Svode
 * terminal as a pair, the installed external terminals in the session cwd
 * and copying the resume command. Null without a listed session.
 */
export function useSessionContinuationGroup({
  session,
  shownIn,
  ptyId,
  svodeTerminal,
  cwd,
  resumeCommand,
  onOpenInChat,
  onOpenInSvodeTerminal,
  onCopyResumeCommand,
}: {
  session: AgentSession | null;
  shownIn: "chat" | "terminal";
  /** A Svode terminal that runs the session keeps the chat away. */
  ptyId: string | null;
  svodeTerminal: TerminalActionAvailability;
  /** Where an external terminal opens; none disables the terminals. */
  cwd: string | null;
  resumeCommand: string | null;
  onOpenInChat(): void;
  onOpenInSvodeTerminal(): void;
  onCopyResumeCommand(): void;
}): OpenWithGroup | null {
  const agents = useAgentAdapterDictionary();
  const target = useMemo<ExternalOpenTarget>(
    () => ({
      preferenceKey: SESSION_CONTINUATION_PREFERENCE_KEY,
      listApps: listExternalTerminalApps,
      open: async (appId) => {
        if (cwd)
          await openSessionCwdInExternalTerminal(cwd, appId ?? undefined);
      },
    }),
    [cwd],
  );
  const handleError = useCallback((error: unknown) => {
    toast.error(m.sessions_toast_external_terminal_failed(), {
      description: getNativeErrorMessage(error),
    });
  }, []);
  const terminals = useExternalOpen(target, handleError);
  if (!session) return null;

  const chat = openInChatAvailability(session, ptyId);
  const chatReason = chat.available
    ? null
    : chat.reason === "terminal_live"
      ? m.sessions_open_in_chat_terminal_live()
      : chat.reason === "continues_in_ide"
        ? m.sessions_chat_unavailable_continues_in_ide({
            agent: agents.label(session.source),
          })
        : m.sessions_chat_unavailable_not_openable();
  const svodeTerminalReason = svodeTerminal.available
    ? null
    : svodeTerminal.reason === "turn_active"
      ? m.sessions_chat_terminal_during_turn()
      : m.sessions_chat_no_terminal();
  const remembered = cwd ? terminals.primary : null;
  const primaryAction = primaryContinuation({
    shownIn,
    rememberedTerminal: remembered?.id ?? null,
    chat,
    svodeTerminal,
  });

  let primary: OpenWithAction;
  if (primaryAction.kind === "external_terminal" && remembered) {
    primary = {
      label: m.external_open_in({ name: remembered.label }),
      renderIcon: (dataIcon) => (
        <ExternalAppIcon app={remembered} data-icon={dataIcon} />
      ),
      run: () => void terminals.openPrimary(),
    };
  } else if (primaryAction.kind === "svode_terminal") {
    primary = {
      label: m.sessions_action_open_in_svode_terminal(),
      renderIcon: (dataIcon) => <SquareTerminal data-icon={dataIcon} />,
      run: onOpenInSvodeTerminal,
      disabledReason: svodeTerminalReason,
    };
  } else {
    primary = {
      label: m.sessions_action_open_in_chat(),
      renderIcon: (dataIcon) => <MessagesSquare data-icon={dataIcon} />,
      run: onOpenInChat,
      disabledReason: chatReason,
    };
  }

  // The chat and the Svode terminal leave the remembered terminal, so the
  // pair is primary again.
  const pairItem =
    shownIn === "terminal" ? (
      <PairItem
        kind="chat"
        icon={<MessagesSquare className="size-5" />}
        label={m.sessions_open_with_chat()}
        reason={chatReason}
        onSelect={() => {
          terminals.forget();
          onOpenInChat();
        }}
      />
    ) : (
      <PairItem
        kind="svode-terminal"
        icon={<SquareTerminal className="size-5" />}
        label={m.sessions_open_with_svode_terminal()}
        reason={svodeTerminalReason}
        onSelect={() => {
          terminals.forget();
          onOpenInSvodeTerminal();
        }}
      />
    );

  return {
    primary,
    pending: terminals.pending,
    onMenuOpen: terminals.refresh,
    items: (
      <>
        <DropdownMenuGroup>
          {pairItem}
          {terminals.apps.map((app) => (
            <DropdownMenuItem
              key={app.id}
              disabled={terminals.pending || !cwd}
              data-session-terminal={app.id}
              onSelect={() => void terminals.choose(app)}
            >
              <ExternalAppIcon app={app} className="size-5" />
              <span className="min-w-0 truncate">{app.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem
            disabled={!resumeCommand}
            data-session-continuation="copy-resume-command"
            onSelect={onCopyResumeCommand}
          >
            <Copy className="size-5" />
            {m.sessions_action_copy_resume_command()}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </>
    ),
  };
}

function PairItem({
  kind,
  icon,
  label,
  reason,
  onSelect,
}: {
  kind: "chat" | "svode-terminal";
  icon: ReactNode;
  label: string;
  reason: string | null;
  onSelect(): void;
}) {
  return (
    <DropdownMenuItem
      disabled={reason !== null}
      data-session-continuation={kind}
      onSelect={onSelect}
    >
      {icon}
      <span className="flex min-w-0 flex-col">
        {label}
        {reason !== null && (
          <span className="text-xs text-muted-foreground">{reason}</span>
        )}
      </span>
    </DropdownMenuItem>
  );
}
