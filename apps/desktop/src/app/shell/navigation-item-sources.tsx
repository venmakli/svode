import { useEffect, useRef } from "react";
import {
  useAgentActorNavigationSource,
  usePersonNavigationSource,
} from "@/features/actors";
import { useAgentContextNavigationSource } from "@/features/agent-context";
import {
  getNavigationState,
  isNavigationItemKey,
  navigationKeyId,
  publishNavigationItemDisplays,
  useNavigationState,
  type NavigationItemKey,
  type NavigationItemSource,
  type NavigationResolvedItem,
} from "@/features/navigation";
import { useRoutineNavigationSource } from "@/features/routines";
import { useSpace } from "@/features/space";
import { applyNavigationSource } from "./navigation-item-source-model";

interface SourceGroup {
  id: string;
  kind: NavigationItemKey["kind"];
  projectPath: string;
  spaceId: string;
  spacePath: string;
  ownerPath: string;
  items: NavigationResolvedItem[];
}

/**
 * Reads the domain sources of the pinned and kept items of the open project:
 * each row shows the name and icon its domain gives the item now and keeps
 * it as the last known name; an item the read source confirms gone leaves
 * Now and Pinned. Items of a Space Desktop does not show ready stay as they
 * are. Mount once in app composition.
 */
export function NavigationItemSources() {
  const pinned = useNavigationState((state) => state.pinned);
  const kept = useNavigationState((state) => state.kept);
  const projectPath = useNavigationState((state) => state.projectPath);
  const rootId = useSpace((state) => state.activeRootId);
  const rootPath = useSpace((state) => state.activeRootPath);
  const spaces = useSpace((state) => state.spaces);
  if (!rootId || !rootPath || projectPath !== rootPath) return null;

  const groups = new Map<string, SourceGroup>();
  for (const item of [...pinned, ...kept]) {
    const key = item.key;
    if (!isNavigationItemKey(key) || item.available === false) continue;
    const spacePath = key.spaceId
      ? spaces.find(
          (space) => space.id === key.spaceId && space.status === "ready",
        )?.path
      : rootPath;
    if (!spacePath) continue;
    const ownerPath = key.kind === "routine" ? key.ownerPath : ".";
    const id = JSON.stringify([key.kind, key.spaceId ?? null, ownerPath]);
    const group = groups.get(id) ?? {
      id,
      kind: key.kind,
      projectPath: rootPath,
      spaceId: key.spaceId ?? rootId,
      spacePath,
      ownerPath,
      items: [],
    };
    group.items.push(item);
    groups.set(id, group);
  }
  return (
    <>
      {[...groups.values()].map((group) => {
        switch (group.kind) {
          case "routine":
            return <RoutineSource key={group.id} group={group} />;
          case "agentActor":
            return <AgentActorSource key={group.id} group={group} />;
          case "person":
            return <PersonSource key={group.id} group={group} />;
          case "contextItem":
            return <ContextItemSource key={group.id} group={group} />;
        }
      })}
    </>
  );
}

function RoutineSource({ group }: { group: SourceGroup }) {
  const source = useRoutineNavigationSource({
    ownerKind:
      group.ownerPath === "." ? "registered_space" : "collection_directory",
    ownerPath: group.ownerPath,
    projectPath: group.projectPath,
    spaceId: group.spaceId,
    spacePath: group.spacePath,
  });
  useApplyNavigationSource(group.items, source);
  return null;
}

function AgentActorSource({ group }: { group: SourceGroup }) {
  const source = useAgentActorNavigationSource(
    group.projectPath,
    group.spacePath,
  );
  useApplyNavigationSource(group.items, source);
  return null;
}

function PersonSource({ group }: { group: SourceGroup }) {
  const source = usePersonNavigationSource(group.spacePath);
  useApplyNavigationSource(group.items, source);
  return null;
}

function ContextItemSource({ group }: { group: SourceGroup }) {
  const source = useAgentContextNavigationSource({
    ownerKey: `space:${group.spaceId}`,
    projectPath: group.projectPath,
    spacePath: group.spacePath,
  });
  useApplyNavigationSource(group.items, source);
  return null;
}

/**
 * Applies a read source to its items: displays for the rows, the snapshot
 * title refreshed once per new name, confirmed-missing items forgotten.
 */
function useApplyNavigationSource(
  items: readonly NavigationResolvedItem[],
  source: NavigationItemSource,
) {
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });
  const itemsKey = JSON.stringify(
    items.map((item) => [navigationKeyId(item.key), item.title]),
  );
  const retitled = useRef(new Map<string, string>());
  useEffect(() => {
    if (!source) return;
    const navigation = getNavigationState();
    const { displays, retitles, gone } = applyNavigationSource(
      itemsRef.current,
      source,
      retitled.current,
    );
    for (const item of retitles) {
      void navigation
        .retitle(item)
        .catch((error: unknown) =>
          console.error("Failed to refresh the navigation title:", error),
        );
    }
    publishNavigationItemDisplays(displays);
    if (gone.length > 0) void navigation.forget(gone);
  }, [itemsKey, source]);
}
