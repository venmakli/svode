import { useState } from "react";
import { useAgentAdapterDictionary } from "@/features/agent-adapters";
import { useAgentSetups } from "../hooks/use-agent-setups";
import { useMcpIntegrations } from "../hooks/use-mcp-integrations";
import { agentFound } from "../model/agent-row";
import { AgentsGroup } from "./agents-group";
import { ProvidersRuntimeGroup } from "./providers-runtime-group";
import { SvodeIntegrationGroup } from "./svode-integration-group";
import { SvodeToolsDialog } from "./svode-tools-dialog";

/**
 * The agents, then what of Svode is installed for them, then the runtime of
 * the machine. The page keeps one list of agents.
 */
export function ProvidersSection() {
  const agents = useAgentSetups();
  const integration = useMcpIntegrations();
  const names = useAgentAdapterDictionary();
  const [manageOpen, setManageOpen] = useState(false);
  const { status, doctor } = integration;
  const label = (agent: string) => names.label(agent);
  const foundAgents =
    agents.setups?.filter(agentFound).map((setup) => setup.agent) ?? [];

  return (
    <>
      <AgentsGroup
        agents={agents}
        integration={status}
        onRunIntegration={integration.run}
        refreshing={agents.refreshing || integration.refreshing}
        onRefresh={() => {
          void agents.refresh();
          void integration.loadStatus();
        }}
      />

      <SvodeIntegrationGroup
        status={status}
        doctorBridgeIncompatible={doctor?.bridgeCompatible === false}
        activity={integration.activity}
        changed={integration.changed}
        label={label}
        onManage={() => setManageOpen(true)}
        onRun={(operation) => void integration.run(operation)}
        onCopyManualConfig={() => void integration.handleCopyConfig()}
      />

      <ProvidersRuntimeGroup
        server={status?.server}
        doctor={doctor}
        doctorPending={integration.doctorPending}
        onRunDoctor={() => void integration.handleDoctor()}
      />

      {manageOpen && status ? (
        <SvodeToolsDialog
          status={status}
          foundAgents={foundAgents}
          label={label}
          run={integration.run}
          onClose={() => setManageOpen(false)}
        />
      ) : null}
    </>
  );
}
