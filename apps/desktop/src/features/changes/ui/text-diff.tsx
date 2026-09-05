import { useMemo } from "react";
import { MultiFileDiff } from "@pierre/diffs/react";
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
  const oldFile = useMemo(
    () => ({ name: item.path, contents: item.before ?? "" }),
    [item.path, item.before],
  );
  const newFile = useMemo(
    () => ({ name: item.path, contents: item.after ?? "" }),
    [item.path, item.after],
  );
  return (
    <MultiFileDiff oldFile={oldFile} newFile={newFile} options={options} />
  );
}
