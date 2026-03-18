import { create } from "zustand";

interface ChatStatusState {
  agentStatus: "idle" | "thinking" | "writing" | "tool-calling";
  setAgentStatus: (status: ChatStatusState["agentStatus"]) => void;
}

export const useChatStatusStore = create<ChatStatusState>((set) => ({
  agentStatus: "idle",
  setAgentStatus: (status) => set({ agentStatus: status }),
}));
