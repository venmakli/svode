import { create } from "zustand";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
}

interface ChatStatusState {
  agentStatus: "idle" | "thinking" | "writing" | "tool-calling" | "awaiting-permission";
  setAgentStatus: (status: ChatStatusState["agentStatus"]) => void;
  pendingPermission: PermissionRequest | null;
  setPendingPermission: (permission: PermissionRequest | null) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
}

export const DEFAULT_MODEL = "sonnet";

export const useChatStatusStore = create<ChatStatusState>((set) => ({
  agentStatus: "idle",
  setAgentStatus: (status) => set({ agentStatus: status }),
  pendingPermission: null,
  setPendingPermission: (permission) => set({ pendingPermission: permission }),
  selectedModel: DEFAULT_MODEL,
  setSelectedModel: (model) => set({ selectedModel: model }),
}));
