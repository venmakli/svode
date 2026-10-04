import { useEffect, useMemo, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
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

function ThemedFileDiff({ diff }: { diff: FileDiffMetadata }) {
  const { theme } = useTheme();
  const themedOptions = useMemo(
    () => ({ ...options, themeType: theme }),
    [theme],
  );
  return <FileDiff fileDiff={diff} options={themedOptions} />;
}

export function TextDiff({ item }: { item: WorkingTreeItem }) {
  return item.diff ? <ThemedFileDiff diff={item.diff} /> : null;
}

const LIMITS = { context: 3, timeout: 100, maxEditLength: 10_000 };

/**
 * The diff of one file's text before and after a change made outside Git,
 * such as an agent's edit. `before` is null for a new file. Shows `fallback`
 * when the diff cannot be computed within its limits.
 */
export function FileTextDiff({
  path,
  before,
  after,
  fallback = null,
}: {
  path: string;
  before: string | null;
  after: string;
  fallback?: React.ReactNode;
}) {
  const [state, setState] = useState<{
    key: string;
    diff: FileDiffMetadata | null;
  } | null>(null);
  const key = `${path}\n${before ?? ""}\n${after}`;
  useEffect(() => {
    let cancelled = false;
    void import("@pierre/diffs").then(({ parseDiffFromFile }) => {
      if (cancelled) return;
      let diff: FileDiffMetadata | null;
      try {
        diff = parseDiffFromFile(
          { name: path, contents: before ?? "" },
          { name: path, contents: after },
          LIMITS,
        );
      } catch {
        diff = null;
      }
      setState({ key, diff });
    });
    return () => {
      cancelled = true;
    };
  }, [after, before, key, path]);
  if (!state || state.key !== key) return null;
  return state.diff ? <ThemedFileDiff diff={state.diff} /> : fallback;
}
