import { useState, useEffect, useCallback, useRef } from "react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useWorkspaceStore } from "@/stores/workspace";
import { useChatStatusStore } from "@/stores/chat";

interface TextDeltaPayload {
  type: "textDelta";
  session_id: string;
  delta: string;
}

interface ToolCallPayload {
  type: "toolCall";
  session_id: string;
  name: string;
  args: Record<string, unknown>;
  id: string;
}

interface ReasoningPayload {
  type: "reasoning";
  session_id: string;
  text: string;
}

interface ErrorPayload {
  type: "error";
  session_id: string;
  message: string;
}

interface DonePayload {
  type: "done";
  session_id: string;
  message_id: string;
}

let msgCounter = 0;
function generateId() {
  return `msg-${Date.now()}-${++msgCounter}`;
}

/** Extract current text from ThreadMessageLike content */
function getTextFromContent(content: ThreadMessageLike["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if ("type" in part && part.type === "text" && "text" in part) {
      return (part as { type: "text"; text: string }).text;
    }
  }
  return "";
}

/** Replace last assistant message in array */
function updateLastAssistant(
  prev: readonly ThreadMessageLike[],
  updater: (last: ThreadMessageLike) => ThreadMessageLike,
): readonly ThreadMessageLike[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant") return prev;
  return [...prev.slice(0, -1), updater(last)];
}

const convertMessage = (message: ThreadMessageLike): ThreadMessageLike => message;

export function ChatRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);

  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const sessionId = activeWorkspaceId ?? "default";
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const workspacePath = activeWorkspace?.path ?? "";

  // Reset when workspace changes
  useEffect(() => {
    setMessages([]);
    setIsRunning(false);
  }, [sessionId]);

  // Listen to Tauri agent events
  // Use cancelled flag to handle async listener registration + React Strict Mode
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    async function setup() {
      const listeners = await Promise.all([
        listen<TextDeltaPayload>("agent:text-delta", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("writing");
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const current = getTextFromContent(last.content);
              return { ...last, content: current + e.payload.delta };
            }),
          );
        }),

        listen<ToolCallPayload>("agent:tool-call", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("tool-calling");
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const current = getTextFromContent(last.content);
              const toolInfo = `\n\n> **${e.payload.name}**`;
              return { ...last, content: current + toolInfo };
            }),
          );
        }),

        listen<ReasoningPayload>("agent:reasoning", () => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("thinking");
        }),

        listen<ErrorPayload>("agent:error", (e) => {
          if (cancelled) return;
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => ({
              ...last,
              content: `Error: ${e.payload.message}`,
            })),
          );
          setIsRunning(false);
          useChatStatusStore.getState().setAgentStatus("idle");
        }),

        listen<DonePayload>("agent:done", () => {
          if (cancelled) return;
          setIsRunning(false);
          useChatStatusStore.getState().setAgentStatus("idle");
        }),
      ]);

      if (cancelled) {
        // Effect was cleaned up while we were awaiting — tear down immediately
        for (const unlisten of listeners) unlisten();
        return;
      }

      unlisteners.push(...listeners);
    }

    setup();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [sessionId]);

  // Handle new message from composer
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const textPart = message.content.find((p) => p.type === "text");
      if (!textPart || textPart.type !== "text" || !textPart.text.trim()) return;

      const text = textPart.text;

      const userMsg: ThreadMessageLike = {
        role: "user",
        content: text,
        id: generateId(),
      };
      const assistantMsg: ThreadMessageLike = {
        role: "assistant",
        content: "",
        id: generateId(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsRunning(true);
      useChatStatusStore.getState().setAgentStatus("thinking");

      try {
        await invoke("agent_send", {
          workspacePath,
          sessionId,
          message: text,
          config: null,
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          updateLastAssistant(prev, (last) => ({
            ...last,
            content: `Error: ${errMsg}`,
          })),
        );
        setIsRunning(false);
        useChatStatusStore.getState().setAgentStatus("idle");
      }
    },
    [workspacePath, sessionId],
  );

  // Handle cancel
  const onCancel = useCallback(async () => {
    try {
      await invoke("agent_stop", { sessionId });
    } catch {
      // Session may have already finished
    }
    setIsRunning(false);
    useChatStatusStore.getState().setAgentStatus("idle");
  }, [sessionId]);

  const runtime = useExternalStoreRuntime({
    messages,
    setMessages,
    isRunning,
    onNew,
    onCancel,
    convertMessage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
