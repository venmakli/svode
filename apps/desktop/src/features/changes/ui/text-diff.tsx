import { useMemo } from "react";
import { FileDiff } from "@pierre/diffs/react";
import { useTheme } from "@/components/ui/theme-provider";
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
  const { theme } = useTheme();
  const themedOptions = useMemo(
    () => ({ ...options, themeType: theme }),
    [theme],
  );
  return item.diff ? (
    <FileDiff fileDiff={item.diff} options={themedOptions} />
  ) : null;
}
