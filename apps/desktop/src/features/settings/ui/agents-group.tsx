import { useCallback, useState } from "react";
import { ArrowUpRight, RefreshCw, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import type { AgentSetupDto } from "../api";
import type { AgentSetups } from "../hooks/use-agent-setups";
import {
  agentFound,
  agentRowView,
  enableInstallsAdapter,
  type AgentRowAction,
} from "../model/agent-row";
import { AgentRow } from "./agent-row";
import { AgentSignInDialog } from "./agent-sign-in-dialog";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
  SettingsRows,
} from "./settings-layout";

type Confirmation = { kind: "enable" | "remove"; setup: AgentSetupDto };

/**
 * The one list of agents: found agents with their state and switch, then
 * the agents that are not found with the vendor's install hint.
 */
export function AgentsGroup({
  agents,
  refreshing,
  onRefresh,
}: {
  agents: AgentSetups;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const names = useAgentAdapterDictionary();
  // The last confirmation stays rendered while its dialog closes.
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [signIn, setSignIn] = useState<{
    agent: string;
    ptyId: string;
  } | null>(null);
  const [notFoundOpen, setNotFoundOpen] = useState(false);
  const { setups, reload } = agents;
  const found = setups?.filter(agentFound) ?? [];
  const notFound = setups?.filter((setup) => !agentFound(setup)) ?? [];

  const confirm = (next: Confirmation) => {
    setConfirmation(next);
    setConfirmationOpen(true);
  };

  const openSignIn = async (agent: string) => {
    const ptyId = await agents.signIn(agent);
    if (ptyId) setSignIn({ agent, ptyId });
  };

  const toggle = (setup: AgentSetupDto, enabled: boolean) => {
    if (enabled && enableInstallsAdapter(setup)) {
      confirm({ kind: "enable", setup });
      return;
    }
    void agents.setEnabled(setup, enabled);
  };

  const act = (setup: AgentSetupDto, action: AgentRowAction) => {
    if (action === "sign_in") return void openSignIn(setup.agent);
    if (action === "update") return void agents.updateAdapter(setup.agent);
    const activity = agents.activity(setup.agent);
    const operation =
      activity?.kind === "failed" ? activity.operation : "check";
    switch (operation) {
      case "enable":
      case "install":
        return void agents.setEnabled(setup, true);
      case "disable":
        return void agents.setEnabled(setup, false);
      case "update":
        return void agents.updateAdapter(setup.agent);
      case "remove":
        return void agents.removeAdapter(setup.agent);
      case "sign_in":
        return void openSignIn(setup.agent);
      case "check":
        return void agents.check(setup.agent);
    }
  };

  const signedIn = useCallback(() => void reload(), [reload]);
  const label = (agent: string) => names.label(agent);
  const confirmed = confirmation?.setup;
  const adapter = confirmed?.adapter;

  return (
    <>
      <SettingsGroup
        description={m.settings_agents_description()}
        aria-busy={!setups}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
          >
            <RefreshCw
              data-icon="inline-start"
              className={refreshing ? "animate-spin" : undefined}
            />
            {m.settings_mcp_refresh()}
          </Button>
        }
        callout={
          agents.loadFailed ? (
            <Alert variant="destructive" className="min-w-0 max-w-full">
              <TriangleAlert data-icon="inline-start" />
              <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                {m.settings_agents_load_failed()}
              </AlertDescription>
            </Alert>
          ) : null
        }
      >
        {setups
          ? [
              ...found.map((setup) => (
                <AgentRow
                  key={setup.agent}
                  setup={setup}
                  label={label(setup.agent)}
                  view={agentRowView(setup, agents.activity(setup.agent))}
                  onToggle={(enabled) => toggle(setup, enabled)}
                  onAction={(action) => act(setup, action)}
                  onCheck={() => void agents.check(setup.agent)}
                  onRemoveAdapter={() => confirm({ kind: "remove", setup })}
                />
              )),
              notFound.length ? (
                <Collapsible
                  key="not-found"
                  open={notFoundOpen}
                  onOpenChange={setNotFoundOpen}
                  data-agents-not-found
                  className="min-w-0"
                >
                  <SettingsItem
                    title={m.settings_agents_not_found({
                      count: String(notFound.length),
                    })}
                    description={m.settings_agents_not_found_description()}
                    actions={
                      <SettingsDisclosureTrigger
                        open={notFoundOpen}
                        label={
                          notFoundOpen
                            ? m.settings_agents_not_found_hide()
                            : m.settings_agents_not_found_show()
                        }
                      />
                    }
                  />
                  <CollapsibleContent className="min-w-0 border-t bg-muted/40">
                    <SettingsRows>
                      {notFound.map((setup) => (
                        <SettingsItem
                          key={setup.agent}
                          data-agent={setup.agent}
                          title={label(setup.agent)}
                          actions={
                            <Button
                              asChild
                              variant="link"
                              size="sm"
                              className="h-auto p-0"
                            >
                              <a
                                href={setup.installHint}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {m.settings_agents_install()}
                                <ArrowUpRight data-icon="inline-end" />
                              </a>
                            </Button>
                          }
                        />
                      ))}
                    </SettingsRows>
                  </CollapsibleContent>
                </Collapsible>
              ) : null,
            ].filter(Boolean)
          : [
              <SettingsRowSkeleton key="first" />,
              <SettingsRowSkeleton key="second" />,
            ]}
      </SettingsGroup>

      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          {confirmed ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {confirmation.kind === "enable"
                    ? m.settings_agents_enable_title({
                        agent: label(confirmed.agent),
                      })
                    : m.settings_agents_remove_title({
                        agent: label(confirmed.agent),
                      })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {confirmation.kind === "enable"
                    ? m.settings_agents_enable_description({
                        agent: label(confirmed.agent),
                        package: adapter?.package ?? "",
                        version: adapter?.pinnedVersion ?? "",
                      })
                    : m.settings_agents_remove_description({
                        agent: label(confirmed.agent),
                      })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{m.project_cancel()}</AlertDialogCancel>
                {confirmation.kind === "enable" ? (
                  <AlertDialogAction
                    onClick={() => void agents.setEnabled(confirmed, true)}
                  >
                    {m.settings_agents_enable_action()}
                  </AlertDialogAction>
                ) : (
                  <AlertDialogAction
                    variant="destructive"
                    onClick={() => void agents.removeAdapter(confirmed.agent)}
                  >
                    {m.settings_agents_remove_adapter()}
                  </AlertDialogAction>
                )}
              </AlertDialogFooter>
            </>
          ) : null}
        </AlertDialogContent>
      </AlertDialog>

      {signIn ? (
        <AgentSignInDialog
          agent={label(signIn.agent)}
          ptyId={signIn.ptyId}
          onSignedIn={signedIn}
          onClose={() => {
            setSignIn(null);
            void reload();
          }}
        />
      ) : null}
    </>
  );
}
