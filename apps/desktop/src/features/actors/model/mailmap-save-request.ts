import { create } from "zustand";

interface ActorMailmapSaveRequest {
  id: number;
  projectPath: string;
  spacePath: string;
}

interface ActorMailmapSaveRequestState {
  request: ActorMailmapSaveRequest | null;
  agentCatalogRequest: AgentActorCatalogSaveRequest | null;
}

interface AgentActorCatalogSaveRequest extends ActorMailmapSaveRequest {
  ownerPath: string | null;
}

let nextRequestId = 1;

export const useActorMailmapSaveRequest = create<ActorMailmapSaveRequestState>(
  () => ({ agentCatalogRequest: null, request: null }),
);

export function requestActorMailmapSave(input: {
  projectPath: string;
  spacePath: string;
}) {
  useActorMailmapSaveRequest.setState({
    request: { ...input, id: nextRequestId++ },
  });
}

export function requestAgentActorCatalogSave(input: {
  ownerPath?: string;
  projectPath: string;
  spacePath: string;
}) {
  useActorMailmapSaveRequest.setState({
    agentCatalogRequest: {
      id: nextRequestId++,
      ownerPath: input.ownerPath ?? null,
      projectPath: input.projectPath,
      spacePath: input.spacePath,
    },
  });
}

export function consumeAgentActorCatalogSaveRequest(requestId: number) {
  const current = useActorMailmapSaveRequest.getState().agentCatalogRequest;
  if (current?.id !== requestId) return false;
  useActorMailmapSaveRequest.setState({ agentCatalogRequest: null });
  return true;
}

export function consumeActorMailmapSaveRequest(requestId: number) {
  const current = useActorMailmapSaveRequest.getState().request;
  if (current?.id !== requestId) return false;
  useActorMailmapSaveRequest.setState({ request: null });
  return true;
}
