import { ChatPanel } from "@/features/chat/chat-panel";

/**
 * Shown when a project has no documents and no children.
 * Renders fullscreen chat — the AI agent can help create first docs.
 */
export function EmptyProjectState() {
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatPanel />
      </div>
    </div>
  );
}
