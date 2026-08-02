import { create } from "zustand";

interface ActorMailmapSaveRequest {
  id: number;
  projectPath: string;
  spacePath: string;
}

interface ActorMailmapSaveRequestState {
  request: ActorMailmapSaveRequest | null;
}

let nextRequestId = 1;

export const useActorMailmapSaveRequest = create<ActorMailmapSaveRequestState>(
  () => ({ request: null }),
);

export function requestActorMailmapSave(input: {
  projectPath: string;
  spacePath: string;
}) {
  useActorMailmapSaveRequest.setState({
    request: { ...input, id: nextRequestId++ },
  });
}
