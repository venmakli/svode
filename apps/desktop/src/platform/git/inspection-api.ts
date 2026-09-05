import { invokeCommand } from "@/platform/native/invoke";

export interface WorkingTreeItemDto {
  path: string;
  generation: string;
  state:
    | "text"
    | "no_content_diff"
    | "binary"
    | "invalid_encoding"
    | "truncated"
    | "gitlink"
    | "metadata"
    | "conflict"
    | "disappeared";
  title?: string | null;
  previousPath?: string | null;
  beforeBytes?: number;
  afterBytes?: number;
  before: string | null;
  after: string | null;
}

export function getWorkingTreeItem(
  spacePath: string,
  path: string,
  generation: string,
  scope: { kind: "file" | "directory" | "repository"; path: string },
) {
  return invokeCommand<WorkingTreeItemDto>("git_working_tree_item", {
    spacePath,
    path,
    generation,
    scope,
  });
}
