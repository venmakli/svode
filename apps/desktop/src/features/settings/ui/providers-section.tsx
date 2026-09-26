import { RefreshCw, TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { useCliAgents } from "../hooks/use-cli-agents";
import { useMcpIntegrations } from "../hooks/use-mcp-integrations";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ProviderRow } from "./provider-row";
import { SettingsGroup, SettingsRowSkeleton } from "./settings-layout";

const CLIENT_AGENTS = { "claude-code": "claude", codex: "codex" } as const;

export function ProvidersSection() {
  const connections = useMcpIntegrations();
  const cliAgents = useCliAgents();
  const { status, doctor } = connections;
  const runtimeUnavailable = status?.server.status === "not_found";
  const bridgeIncompatible = doctor?.bridgeCompatible === false;
  const refreshing = connections.refreshing || cliAgents.refreshing;

  return (
    <>
      <Alert className="min-w-0 max-w-full">
        <TriangleAlert data-icon="inline-start" />
        <AlertTitle className="min-w-0">
          {m.settings_mcp_pii_warning_title()}
        </AlertTitle>
        <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
          {m.settings_mcp_pii_warning_description()}
        </AlertDescription>
      </Alert>

      <SettingsGroup
        title={m.settings_mcp_clients_section()}
        description={m.settings_providers_description()}
        aria-busy={!status}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void connections.loadStatus();
              void cliAgents.refreshAgents();
            }}
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
          runtimeUnavailable || bridgeIncompatible ? (
            <Alert variant="destructive" className="min-w-0 max-w-full">
              <TriangleAlert data-icon="inline-start" />
              <AlertTitle className="min-w-0">
                {runtimeUnavailable
                  ? m.settings_providers_runtime_unavailable_title()
                  : m.settings_providers_bridge_incompatible_title()}
              </AlertTitle>
              <AlertDescription className="min-w-0 max-w-full break-words [overflow-wrap:anywhere]">
                {runtimeUnavailable
                  ? m.settings_mcp_client_runtime_unavailable()
                  : m.settings_providers_bridge_incompatible_description()}
              </AlertDescription>
            </Alert>
          ) : null
        }
      >
        {status
          ? status.clients.map((client) => (
              <ProviderRow
                key={client.id}
                client={client}
                agent={cliAgents.agents.find(
                  (agent) => agent.name === CLIENT_AGENTS[client.id],
                )}
                server={status.server}
                runtimeUpdatedFrom={status.runtimeUpdatedFrom ?? null}
                runtimeExplained={runtimeUnavailable}
                pending={connections.pendingClients.has(client.id)}
                manualConfig={connections.manualConfigs[client.id]}
                doctor={doctor}
                doctorPending={connections.doctorPending}
                onToggle={(checked) =>
                  void connections.handleToggle(client, checked)
                }
                onShowManualConfig={() =>
                  connections.showManualConfig(client.id)
                }
                onCopyManualConfig={() =>
                  void connections.handleCopyConfig(client.id)
                }
                onRunDoctor={() => void connections.handleDoctor()}
              />
            ))
          : [
              <SettingsRowSkeleton key="first" />,
              <SettingsRowSkeleton key="second" />,
            ]}
      </SettingsGroup>
    </>
  );
}
