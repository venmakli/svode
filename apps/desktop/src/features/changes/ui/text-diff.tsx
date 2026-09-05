import { FileDiff } from "@pierre/diffs/react";
import type { WorkingTreeItem } from "../api/inspection";

const options = {
  diffStyle: "unified",
  diffIndicators: "bars",
  overflow: "wrap",
  disableFileHeader: true,
  hunkSeparators: "line-info-basic",
  lineDiffType: "none",
} as const;

export function TextDiff({ item }: { item: WorkingTreeItem }) {
  return item.diff ? <FileDiff fileDiff={item.diff} options={options} /> : null;
}
