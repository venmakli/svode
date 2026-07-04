import { Inbox } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { AgentSessionsScreen } from "@/features/agent-sessions";
import * as m from "@/paraglide/messages.js";

export function InboxSurface() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{m.inbox_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.inbox_empty_description()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function SessionsSurface({
  onOpenAppSettings,
}: {
  onOpenAppSettings?: () => void;
}) {
  return <AgentSessionsScreen onOpenAppSettings={onOpenAppSettings} />;
}
