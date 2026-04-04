import { create } from "zustand";

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  sessionId: string;
}

export interface DocMention {
  title: string;
  path: string;
  icon: string | null;
}

interface ChatStatusState {
  agentStatus: "idle" | "thinking" | "writing" | "tool-calling" | "awaiting-permission";
  setAgentStatus: (status: ChatStatusState["agentStatus"]) => void;
  pendingPermission: PermissionRequest | null;
  setPendingPermission: (permission: PermissionRequest | null) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  docMentions: DocMention[];
  addDocMention: (doc: DocMention) => void;
  removeDocMention: (path: string) => void;
  clearDocMentions: () => void;
}

export const DEFAULT_MODEL = "sonnet";

export const useChatStatusStore = create<ChatStatusState>((set) => ({
  agentStatus: "idle",
  setAgentStatus: (status) => set({ agentStatus: status }),
  pendingPermission: null,
  setPendingPermission: (permission) => set({ pendingPermission: permission }),
  selectedModel: DEFAULT_MODEL,
  setSelectedModel: (model) => set({ selectedModel: model }),
  docMentions: [],
  addDocMention: (doc) =>
    set((s) =>
      s.docMentions.some((d) => d.path === doc.path)
        ? s
        : { docMentions: [...s.docMentions, doc] },
    ),
  removeDocMention: (path) =>
    set((s) => ({ docMentions: s.docMentions.filter((d) => d.path !== path) })),
  clearDocMentions: () => set({ docMentions: [] }),
}));
