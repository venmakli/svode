import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AttachmentRow, AttachmentsFolder } from "@/features/attachments";
import { getNativeErrorMessage } from "@/platform/native/errors";

import {
  loadAgentContextSkillFiles,
  loadAgentContextSkillMarkdown,
} from "../api/agent-context-api";
import { skillFileRow } from "../model/skill-files";
import type { AgentContextItem, AgentContextSkillFile } from "../model/types";

/**
 * The folder of a skill for the Attachments Table, with the listed file
 * behind each of its rows.
 */
export function useSkillFilesFolder(item: AgentContextItem) {
  const files = useRef(new Map<string, AgentContextSkillFile>());
  const read = useCallback(
    async (branch: string | null) => {
      const listed = await loadAgentContextSkillFiles(item.id, branch ?? "");
      for (const file of listed) files.current.set(file.path, file);
      return listed.map(skillFileRow);
    },
    [item.id],
  );
  const folder = useMemo<AttachmentsFolder>(
    () => ({ key: item.id, read, revision: item.modifiedAt ?? "" }),
    [item.id, item.modifiedAt, read],
  );
  const fileOf = useCallback(
    (row: AttachmentRow) => files.current.get(row.path) ?? null,
    [],
  );
  return { fileOf, folder };
}

export type SkillMarkdownState =
  | { phase: "loading" }
  | { phase: "ready"; markdown: string; truncated: boolean }
  | { phase: "error"; message: string };

/** The text of a Markdown file of a skill, read once per open. */
export function useSkillMarkdownFile(itemId: string, path: string) {
  const [attempt, setAttempt] = useState(0);
  const request = `${attempt}\0${itemId}\0${path}`;
  const [settled, setSettled] = useState<{
    request: string;
    state: SkillMarkdownState;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const settle = (state: SkillMarkdownState) => {
      if (!cancelled) setSettled({ request, state });
    };
    loadAgentContextSkillMarkdown(itemId, path).then(
      (text) => settle({ phase: "ready", ...text }),
      (error: unknown) =>
        settle({ message: getNativeErrorMessage(error), phase: "error" }),
    );
    return () => {
      cancelled = true;
    };
  }, [itemId, path, request]);

  return {
    retry: () => setAttempt((value) => value + 1),
    state:
      settled?.request === request
        ? settled.state
        : ({ phase: "loading" } as const),
  };
}
