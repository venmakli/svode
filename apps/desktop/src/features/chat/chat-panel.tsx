import { useEffect } from "react";
import { Thread } from "@/components/assistant-ui/thread";
import { ChatRuntimeProvider } from "./chat-runtime-provider";
import { ThreadStatusBar } from "./thread-status-bar";
import { BashToolUI, EditToolUI, WriteToolUI, PlanToolUI } from "./tool-uis";
import { useChatStatusStore } from "./model";

function useFocusComposerShortcut() {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "l") {
        e.preventDefault();
        const input = document.querySelector<HTMLTextAreaElement>(
          ".aui-composer-input",
        );
        input?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

function ChatContent() {
  const isRunning = useChatStatusStore((s) => s.agentStatus !== "idle");
  useFocusComposerShortcut();

  return (
    <div className="flex h-full flex-col">
      <BashToolUI />
      <EditToolUI />
      <WriteToolUI />
      <PlanToolUI />
      <div className="flex-1 min-h-0 overflow-hidden">
        <Thread />
      </div>
      <ThreadStatusBar isRunning={isRunning} />
    </div>
  );
}

export function ChatPanel() {
  return (
    <ChatRuntimeProvider>
      <ChatContent />
    </ChatRuntimeProvider>
  );
}
