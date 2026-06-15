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

export interface ModelOption {
  id: string;
  name: string;
  description: string;
}

export const DEFAULT_MODEL = "sonnet";

interface ChatStatusState {
  agentStatus: "idle" | "thinking" | "writing" | "tool-calling" | "awaiting-permission";
  setAgentStatus: (status: ChatStatusState["agentStatus"]) => void;
  pendingPermission: PermissionRequest | null;
  setPendingPermission: (permission: PermissionRequest | null) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  availableModels: ModelOption[];
  setAvailableModels: (models: ModelOption[]) => void;
  applyDefaultModel: (defaultModel: string | undefined) => void;
  docMentions: DocMention[];
  addDocMention: (doc: DocMention) => void;
  removeDocMention: (path: string) => void;
  clearDocMentions: () => void;
}

export const useChatStatusStore = create<ChatStatusState>((set) => ({
  agentStatus: "idle",
  setAgentStatus: (status) => set({ agentStatus: status }),
  pendingPermission: null,
  setPendingPermission: (permission) => set({ pendingPermission: permission }),
  selectedModel: DEFAULT_MODEL,
  setSelectedModel: (model) => set({ selectedModel: model }),
  availableModels: [],
  setAvailableModels: (models) => set({ availableModels: models }),
  applyDefaultModel: (defaultModel) => {
    const { availableModels } = useChatStatusStore.getState();
    const target = defaultModel ?? DEFAULT_MODEL;
    const validDefault = availableModels.some((m) => m.id === target) ? target : availableModels[0]?.id ?? DEFAULT_MODEL;
    set({ selectedModel: validDefault });
  },
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
