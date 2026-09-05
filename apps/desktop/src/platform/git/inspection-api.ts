import { invokeCommand } from "@/platform/native/invoke";

export interface WorkingTreeItemDto {
  path: string;
  generation: string;
  state:
    | "text"
    | "no_content_diff"
    | "binary"
    | "invalid_encoding"
    | "truncated";
  before: string | null;
  after: string | null;
}

export function getWorkingTreeItem(
  spacePath: string,
  path: string,
  generation: string,
) {
  return invokeCommand<WorkingTreeItemDto>("git_working_tree_item", {
    spacePath,
    path,
    generation,
  });
}
