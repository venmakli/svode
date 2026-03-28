import { useState, useEffect, useCallback } from "react";
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
import { extractMentions } from "./composer-mentions";

interface TextDeltaPayload {
  type: "textDelta";
  session_id: string;
  delta: string;
}

interface ToolCallPayload {
  type: "toolCall";
  session_id: string;
  name: string;
  args: Record<string, JSONValue>;
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

interface ToolInputDeltaPayload {
  type: "toolInputDelta";
  session_id: string;
  id: string;
  delta: string;
}

interface DonePayload {
  type: "done";
  session_id: string;
  message_id: string;
}

interface PermissionRequestPayload {
  type: "permissionRequest";
  session_id: string;
  request_id: string;
  tool_name: string;
  input: Record<string, unknown>;
  tool_use_id: string;
}

// Content part types matching assistant-ui's ThreadMessageLike content
type TextPart = { type: "text"; text: string };
type ReasoningPart = { type: "reasoning"; text: string };
type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, JSONValue>; argsText?: string; result?: unknown };
type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
type ContentPart = TextPart | ReasoningPart | ToolCallPart;

/** Mark all tool-call parts that have no result as complete */
function markToolCallsDone(parts: ContentPart[]): ContentPart[] {
  let changed = false;
  const result = parts.map((p) => {
    if (p.type === "tool-call" && (p as ToolCallPart).result === undefined) {
      changed = true;
      return { ...p, result: "Done" };
    }
    return p;
  });
  return changed ? result : parts;
}

let msgCounter = 0;
function generateId() {
  return `msg-${Date.now()}-${++msgCounter}`;
}

/** Get content parts array from message, normalizing string content */
function getContentParts(content: ThreadMessageLike["content"]): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  return content as ContentPart[];
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
    useChatStatusStore.getState().setPendingPermission(null);
  }, [sessionId]);

  // Listen to Tauri agent events
  useEffect(() => {
    let cancelled = false;
    const unlisteners: UnlistenFn[] = [];

    async function setup() {
      const listeners = await Promise.all([
        // Text delta — append to the last text part, or create one.
        // Also mark any preceding tool-call parts as complete.
        listen<TextDeltaPayload>("agent:text-delta", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("writing");
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              let parts = getContentParts(last.content);
              // Mark preceding tool calls as done (they finished if we're getting text now)
              parts = markToolCallsDone(parts);
              const lastText = parts.length > 0 && parts[parts.length - 1].type === "text"
                ? parts[parts.length - 1] as { type: "text"; text: string }
                : null;

              if (lastText) {
                const updated = [...parts];
                updated[updated.length - 1] = { type: "text", text: lastText.text + e.payload.delta };
                return { ...last, content: updated };
              }
              return { ...last, content: [...parts, { type: "text", text: e.payload.delta }] };
            }),
          );
        }),

        // Tool call — add as proper tool-call content part.
        // Mark any preceding tool-calls as done first.
        listen<ToolCallPayload>("agent:tool-call", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("tool-calling");
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const parts = markToolCallsDone(getContentParts(last.content));
              return {
                ...last,
                content: [
                  ...parts,
                  {
                    type: "tool-call" as const,
                    toolCallId: e.payload.id,
                    toolName: e.payload.name,
                    args: e.payload.args,
                  },
                ],
              };
            }),
          );
        }),

        // Tool input delta — accumulate argsText on last tool-call part
        listen<ToolInputDeltaPayload>("agent:tool-input-delta", (e) => {
          if (cancelled) return;
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const parts = getContentParts(last.content);
              // Find the last tool-call part and append argsText
              for (let i = parts.length - 1; i >= 0; i--) {
                if (parts[i].type === "tool-call") {
                  const tc = parts[i] as ToolCallPart;
                  const updated = [...parts];
                  updated[i] = { ...tc, argsText: (tc.argsText ?? "") + e.payload.delta };
                  return { ...last, content: updated };
                }
              }
              return last;
            }),
          );
        }),

        // Reasoning — accumulate as reasoning content part
        listen<ReasoningPayload>("agent:reasoning", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("thinking");
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const parts = getContentParts(last.content);
              // Find last reasoning part to append to
              const lastPart = parts.length > 0 ? parts[parts.length - 1] : null;
              if (lastPart && lastPart.type === "reasoning") {
                const updated = [...parts];
                updated[updated.length - 1] = {
                  type: "reasoning",
                  text: (lastPart as ReasoningPart).text + e.payload.text,
                };
                return { ...last, content: updated };
              }
              // New reasoning part
              return { ...last, content: [...parts, { type: "reasoning", text: e.payload.text }] };
            }),
          );
        }),

        // Error — show as text
        listen<ErrorPayload>("agent:error", (e) => {
          if (cancelled) return;
          setMessages((prev) =>
            updateLastAssistant(prev, (last) => {
              const parts = getContentParts(last.content);
              return {
                ...last,
                content: [...parts, { type: "text", text: `Error: ${e.payload.message}` }],
              };
            }),
          );
          setIsRunning(false);
          useChatStatusStore.getState().setAgentStatus("idle");
        }),

        // Done — mark all tool-call parts as complete
        listen<DonePayload>("agent:done", () => {
          if (cancelled) return;
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.role !== "assistant") return msg;
              const parts = getContentParts(msg.content);
              const updated = markToolCallsDone(parts);
              return updated !== parts ? { ...msg, content: updated } : msg;
            }),
          );
          setIsRunning(false);
          useChatStatusStore.getState().setAgentStatus("idle");
        }),

        // Permission request — agent needs user approval
        listen<PermissionRequestPayload>("agent:permission-request", (e) => {
          if (cancelled) return;
          useChatStatusStore.getState().setAgentStatus("awaiting-permission");
          useChatStatusStore.getState().setPendingPermission({
            requestId: e.payload.request_id,
            toolName: e.payload.tool_name,
            input: e.payload.input,
            toolUseId: e.payload.tool_use_id,
            sessionId: sessionId,
          });
        }),
      ]);

      if (cancelled) {
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
        content: [],
        id: generateId(),
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      setIsRunning(true);
      useChatStatusStore.getState().setAgentStatus("thinking");

      try {
        const model = useChatStatusStore.getState().selectedModel;

        // Resolve [[Title]] mentions to file context
        const { fileTrees, activeWorkspaceId } = useWorkspaceStore.getState();
        const tree = activeWorkspaceId ? fileTrees[activeWorkspaceId] ?? [] : [];
        const mentions = extractMentions(text, tree);
        let context: { path: string; content: string }[] | null = null;
        if (mentions.length > 0) {
          const entries = await Promise.all(
            mentions.map(async (doc) => {
              try {
                const entry = await invoke<{ content: string }>("read_entry", {
                  workspace: workspacePath,
                  path: doc.path,
                });
                return { path: doc.path, content: entry.content };
              } catch {
                return null;
              }
            }),
          );
          const valid = entries.filter(
            (e): e is { path: string; content: string } => e !== null,
          );
          if (valid.length > 0) context = valid;
        }

        // Build context into message text directly (CLI doesn't support structured context)
        let messageWithContext = text;
        if (context && context.length > 0) {
          const contextBlocks = context.map(
            (f) => `[Context: ${f.path}]\n${f.content}\n[End context]`,
          );
          messageWithContext = contextBlocks.join("\n\n") + "\n\n" + text;
        }

        await invoke("agent_send", {
          workspacePath,
          sessionId,
          message: messageWithContext,
          config: { model },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        setMessages((prev) =>
          updateLastAssistant(prev, (last) => ({
            ...last,
            content: [{ type: "text" as const, text: `Error: ${errMsg}` }],
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
