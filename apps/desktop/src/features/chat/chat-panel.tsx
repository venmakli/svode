import { Thread } from "@/components/assistant-ui/thread";
import { ChatRuntimeProvider } from "./chat-runtime-provider";
import { ThreadStatusBar } from "./thread-status-bar";
import { useChatStatusStore } from "@/stores/chat";

function ChatContent() {
  const isRunning = useChatStatusStore((s) => s.agentStatus !== "idle");

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0">
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
