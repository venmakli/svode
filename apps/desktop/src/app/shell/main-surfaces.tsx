import { Inbox } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  AgentSessionsScreen,
  type AgentSessionOpenRequest,
} from "@/features/agent-sessions";
import {
  KnowledgeGraphScreen,
  knowledgeOpenPath,
  type KnowledgeGraphOpenRequest,
  type KnowledgeNode,
} from "@/features/knowledge";
import { useSelectResult } from "@/features/search/app-shell";
import { useSpace } from "@/features/space";
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
  openRequest,
  onOpenAppSettings,
}: {
  openRequest?: AgentSessionOpenRequest | null;
  onOpenAppSettings?: () => void;
}) {
  return (
    <AgentSessionsScreen
      openRequest={openRequest}
      onOpenAppSettings={onOpenAppSettings}
    />
  );
}

export function GraphSurface({
  openRequest,
  onBeforeNavigation,
  onActivateContent,
}: {
  openRequest: KnowledgeGraphOpenRequest | null;
  onBeforeNavigation?: () => Promise<boolean>;
  onActivateContent: () => void;
}) {
  const activeRootPath = useSpace((state) => state.activeRootPath);
  const activeRootName = useSpace((state) => state.activeRootName);
  const spaces = useSpace((state) => state.spaces);
  const openSource = useSelectResult({
    onBeforeNavigation,
    onAfterNavigation: onActivateContent,
  });
  if (!activeRootPath) return null;

  const handleOpenSource = (node: KnowledgeNode) =>
    openSource({
      spaceId: node.source.spaceId,
      spaceName: node.spaceName,
      path: knowledgeOpenPath(node),
      kind: node.source.kind,
    });

  return (
    <KnowledgeGraphScreen
      key={openRequest?.requestKey ?? 0}
      projectPath={activeRootPath}
      spaces={[
        { id: null, name: activeRootName ?? "Svode" },
        ...spaces
          .filter((space) => space.status === "ready")
          .map((space) => ({ id: space.id, name: space.name })),
      ]}
      openRequest={openRequest}
      onOpenSource={handleOpenSource}
    />
  );
}
