import { invokeCommand } from "@/platform/native/invoke";

export interface AgentAdapterIdentityDto {
  id: string;
  displayName: string;
}

export function listAgentAdapterIdentities(): Promise<
  AgentAdapterIdentityDto[]
> {
  return invokeCommand<AgentAdapterIdentityDto[]>(
    "agent_adapters_list_identities",
  );
}
