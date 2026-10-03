import { useCallback, useState } from "react";
import { ArrowUpRight, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import type { AgentSetupDto, CustomAgentSetupDto } from "../api";
import type { AgentSetups } from "../hooks/use-agent-setups";
import type { CustomAgents } from "../hooks/use-custom-agents";
import type { McpStatus } from "../hooks/use-mcp-integrations";
import {
  ownPartRemoval,
  toolsOffer,
  type IntegrationOperation,
} from "../model/svode-integration";
import {
  agentFound,
  agentRowView,
  enableInstallsAdapter,
  type AgentRowAction,
} from "../model/agent-row";
import {
  AgentConfirmationDialog,
  type AgentConfirmation,
  type AgentConfirmationChoice,
} from "./agent-confirmation-dialog";
import { customAgentRowView } from "../model/custom-agent";
import { AgentRow } from "./agent-row";
import { AgentSignInDialog } from "./agent-sign-in-dialog";
import { CustomAgentDialog } from "./custom-agent-dialog";
import { CustomAgentRemoveDialog } from "./custom-agent-remove-dialog";
import { CustomAgentRow } from "./custom-agent-row";
import {
  SettingsDisclosureTrigger,
  SettingsGroup,
  SettingsItem,
  SettingsRowSkeleton,
  SettingsRows,
} from "./settings-layout";

/**
 * The one list of agents: found agents with their state and switch, the
 * custom ACP agents the user added, the agents that are not found with the
 * vendor's install hint, and the entry to add a custom agent. Turning an
 * agent on can add its Svode tools; turning it off can remove its own part.
 * Svode installs no tools for a custom agent.
 */
export function AgentsGroup({
  agents,
  custom,
  integration,
  onRunIntegration,
  refreshing,
  onRefresh,
}: {
  agents: AgentSetups;
  custom: CustomAgents;
  integration: McpStatus | null;
  onRunIntegration: (operation: IntegrationOperation) => Promise<string | null>;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const names = useAgentAdapterDictionary();
  // The last confirmation stays rendered while its dialog closes.
  const [confirmation, setConfirmation] = useState<AgentConfirmation | null>(
    null,
  );
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [signIn, setSignIn] = useState<{
    agent: string;
    ptyId: string;
  } | null>(null);
  const [notFoundOpen, setNotFoundOpen] = useState(false);
  // The form is open with the agent it edits, or with none to add one.
  const [customForm, setCustomForm] = useState<{
    editing: CustomAgentSetupDto | null;
  } | null>(null);
  // The last agent to remove stays rendered while its dialog closes.
  const [removing, setRemoving] = useState<CustomAgentSetupDto | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { setups, reload } = agents;
  const found = setups?.filter(agentFound) ?? [];
  const notFound = setups?.filter((setup) => !agentFound(setup)) ?? [];

  const confirm = (next: AgentConfirmation) => {
    setConfirmation(next);
    setConfirmationOpen(true);
  };

  const openSignIn = async (agent: string) => {
    const ptyId = await agents.signIn(agent);
    if (ptyId) setSignIn({ agent, ptyId });
  };

  const toggle = (setup: AgentSetupDto, enabled: boolean) => {
    if (enabled) {
      const tools = toolsOffer(integration, setup.agent);
      if (tools || enableInstallsAdapter(setup))
        return confirm({ kind: "enable", setup, tools });
    } else {
      const removal = ownPartRemoval(integration, setup.agent);
      if (removal) return confirm({ kind: "disable", setup, removal });
    }
    void agents.setEnabled(setup, enabled);
  };

  // The agent and its Svode tools change independently: a failure of one
  // leaves the other as it went.
  const confirmed = (
    next: AgentConfirmation,
    choice: AgentConfirmationChoice,
  ) => {
    const agent = next.setup.agent;
    switch (next.kind) {
      case "enable":
        void agents.setEnabled(next.setup, true);
        if (next.tools && choice.addTools)
          void onRunIntegration({ kind: "install", client: agent });
        return;
      case "disable":
        void agents.setEnabled(next.setup, false);
        if (choice.removePart)
          void onRunIntegration({ kind: "remove", client: agent }).then(
            (error) => {
              if (!error && choice.removeShared)
                void onRunIntegration({ kind: "remove_shared" });
            },
          );
        return;
      case "remove":
        void agents.removeAdapter(agent);
    }
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

  const actCustom = (setup: CustomAgentSetupDto) => {
    const activity = custom.activity(setup.agent);
    const operation =
      activity?.kind === "failed" ? activity.operation : "check";
    switch (operation) {
      case "enable":
      case "disable":
        return void custom.setEnabled(setup.agent, operation === "enable");
      case "remove_custom":
        return void custom.remove(setup.agent);
      default:
        return void custom.check(setup.agent);
    }
  };

  const customRows = (custom.agents ?? []).map((setup) => (
    <CustomAgentRow
      key={setup.agent}
      setup={setup}
      view={customAgentRowView(setup, custom.activity(setup.agent))}
      onToggle={(enabled) => void custom.setEnabled(setup.agent, enabled)}
      onAction={() => actCustom(setup)}
      onCheck={() => void custom.check(setup.agent)}
      onEdit={() => setCustomForm({ editing: setup })}
      onRemove={() => {
        setRemoving(setup);
        setRemoveOpen(true);
      }}
    />
  ));

  const signedIn = useCallback(() => void reload(), [reload]);
  const label = (agent: string) => names.label(agent);

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
              ...customRows,
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
              <div key="add-custom" className="px-2 py-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setCustomForm({ editing: null })}
                >
                  <Plus data-icon="inline-start" />
                  {m.settings_agents_custom_add()}
                </Button>
              </div>,
            ].filter(Boolean)
          : [
              <SettingsRowSkeleton key="first" />,
              <SettingsRowSkeleton key="second" />,
            ]}
      </SettingsGroup>

      <AgentConfirmationDialog
        confirmation={confirmation}
        open={confirmationOpen}
        onOpenChange={setConfirmationOpen}
        label={label}
        names={(ids) => ids.map(label).join(", ")}
        onConfirm={confirmed}
      />

      {customForm ? (
        <CustomAgentDialog
          editing={customForm.editing}
          onCheck={custom.checkDraft}
          onSave={async (agent, definition) =>
            (await custom.save(agent, definition)).error
          }
          onClose={() => setCustomForm(null)}
        />
      ) : null}

      {removing ? (
        <CustomAgentRemoveDialog
          name={removing.name}
          open={removeOpen}
          onOpenChange={setRemoveOpen}
          onConfirm={() => void custom.remove(removing.agent)}
        />
      ) : null}

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
