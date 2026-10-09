import type { ComponentProps } from "react";
import { AgentSessionMainSurface } from "@/features/agent-sessions";
import {
  KnowledgeGraphScreen,
  knowledgeOpenPath,
  type KnowledgeGraphOpenRequest,
  type KnowledgeNode,
} from "@/features/knowledge";
import { useSelectResult } from "@/features/search/app-shell";
import { useSpace } from "@/features/space";
import { SpaceBreadcrumbs } from "@/features/space/app-shell";
import { PublishMainHeader } from "./main-header-contribution";
import { useShellStore } from "./model";
import { passNavigationGuards } from "./navigation-guards";
import { useShellView } from "./shell-view";

/** A session in the main area; its identity and ⋯ go to the top bar. */
export function SessionSurface(
  props: Omit<ComponentProps<typeof AgentSessionMainSurface>, "renderHeader">,
) {
  const home = useShellView() === "home";
  const openContentSurface = useShellStore((state) => state.openContentSurface);
  return (
    <AgentSessionMainSurface
      {...props}
      renderHeader={({ spacePath, current, menu }) => (
        <PublishMainHeader
          breadcrumbs={
            <SpaceBreadcrumbs
              home={home}
              spacePath={spacePath}
              current={current}
              onBeforeNavigation={passNavigationGuards}
              onActivateContent={openContentSurface}
            />
          }
          objectActions={menu}
        />
      )}
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
      renderViewTools={(tools) => <PublishMainHeader viewTools={tools} />}
    />
  );
}
