import {
  getWorkingTreeItem,
  type WorkingTreeItemDto,
} from "@/platform/git/inspection-api";
import { openArtifactInTool } from "@/platform/project-openers";
import type { FileDiffMetadata } from "@pierre/diffs";
import type { InspectionScope } from "../model/scope";

export type WorkingTreeItem = WorkingTreeItemDto & {
  diff?: FileDiffMetadata;
  budgetLimited?: boolean;
};

export const loadWorkingTreeItem = getWorkingTreeItem;

export async function prepareTextDiff(
  item: WorkingTreeItem,
): Promise<WorkingTreeItem> {
  if (item.state !== "text") return item;
  const { parseDiffFromFile } = await import("@pierre/diffs");
  const limits = { context: 3, timeout: 100, maxEditLength: 10_000 };
  try {
    const diff = parseDiffFromFile(
      { name: item.path, contents: item.before ?? "" },
      { name: item.path, contents: item.after ?? "" },
      limits,
    );
    return { ...item, diff };
  } catch {
    return { ...item, state: "truncated", before: null, after: null };
  }
}

export function revealChangedSource(scope: InspectionScope, path: string) {
  return openArtifactInTool(
    {
      ownerRoot: scope.spacePath,
      canonicalArtifactPath: `${scope.spacePath}/${path}`,
    },
    "file_manager",
  );
}
