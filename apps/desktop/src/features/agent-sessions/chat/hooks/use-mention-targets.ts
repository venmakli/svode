import { useEffect, useState } from "react";
import { searchMentionTargets, type MentionTarget } from "../api/attachments";

const MENTION_DEBOUNCE_MS = 150;

/** Pages and files of the project an `@` search for `query` offers. */
export function useMentionTargets(
  projectPath: string | null,
  query: string,
): MentionTarget[] {
  const [targets, setTargets] = useState<MentionTarget[]>([]);
  useEffect(() => {
    if (!projectPath) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void searchMentionTargets(projectPath, query).then((found) => {
        if (!cancelled) setTargets(found);
      });
    }, MENTION_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [projectPath, query]);
  return targets;
}
