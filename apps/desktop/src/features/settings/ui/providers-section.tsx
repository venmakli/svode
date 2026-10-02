import { TriangleAlert } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { useAgentSetups } from "../hooks/use-agent-setups";
import { useMcpIntegrations } from "../hooks/use-mcp-integrations";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AgentsGroup } from "./agents-group";
import { ProviderRow } from "./provider-row";
import { ProvidersRuntimeGroup } from "./providers-runtime-group";
import { SettingsGroup, SettingsRowSkeleton } from "./settings-layout";

export function ProvidersSection() {
  const agents = useAgentSetups();
  const connections = useMcpIntegrations();
  const { status, doctor } = connections;
  const runtimeUnavailable = status?.server.status === "not_found";
  const bridgeIncompatible = doctor?.bridgeCompatible === false;

  return (
    <>
      <AgentsGroup
        agents={agents}
        refreshing={agents.refreshing || connections.refreshing}
        onRefresh={() => {
          void agents.refresh();
          void connections.loadStatus();
        }}
      />

      {/* Svode access of Claude Code and Codex as before, until the Svode
          integration block replaces it. */}
      <SettingsGroup
        title={m.settings_providers_access_group()}
        description={m.settings_providers_description()}
        aria-busy={!status}
        data-svode-access
        callout={
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
            {runtimeUnavailable || bridgeIncompatible ? (
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
            ) : null}
          </>
        }
      >
        {status
          ? status.clients.map((client) => (
              <ProviderRow
                key={client.id}
                client={client}
                server={status.server}
                runtimeUpdatedFrom={status.runtimeUpdatedFrom ?? null}
                runtimeExplained={runtimeUnavailable}
                pending={connections.pendingClients.has(client.id)}
                manualConfig={connections.manualConfigs[client.id]}
                onToggle={(checked) =>
                  void connections.handleToggle(client, checked)
                }
                onShowManualConfig={() =>
                  connections.showManualConfig(client.id)
                }
                onCopyManualConfig={() =>
                  void connections.handleCopyConfig(client.id)
                }
              />
            ))
          : [
              <SettingsRowSkeleton key="first" />,
              <SettingsRowSkeleton key="second" />,
            ]}
      </SettingsGroup>

      <ProvidersRuntimeGroup
        server={status?.server}
        doctor={doctor}
        doctorPending={connections.doctorPending}
        onRunDoctor={() => void connections.handleDoctor()}
      />
    </>
  );
}
