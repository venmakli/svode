import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  ConflictProblemAlert,
  ConflictWholeFileAction,
  useConflictFile,
} from "@/features/changes";
import * as m from "@/paraglide/messages.js";

import type { PageMergeUnavailableReason } from "../model/page-merge";

function reasonText(reason: PageMergeUnavailableReason): string {
  if (reason.type === "missing_stage") return m.page_merge_missing_stage();
  switch (reason.stage) {
    case "base":
      return m.page_merge_unreadable_base({ message: reason.message });
    case "ours":
      return m.page_merge_unreadable_ours({ message: reason.message });
    case "theirs":
      return m.page_merge_unreadable_theirs({ message: reason.message });
  }
}

/**
 * A Page whose frontmatter is in conflict without a choice by properties
 * (DF-292 R5): the reason, and «Оставить моё» or «Взять входящее» for the
 * whole Page from the index stages, with confirmation (1.F, item 7).
 */
export function PageMergeUnavailable({
  spacePath,
  path,
  reason,
  readOnly,
}: {
  spacePath: string;
  path: string;
  reason: PageMergeUnavailableReason;
  readOnly: boolean;
}) {
  const conflict = useConflictFile(spacePath, path);
  const { file } = conflict;
  return (
    <div className="flex flex-col gap-3" data-page-merge-unavailable>
      <Alert>
        <TriangleAlert />
        <AlertTitle>{m.page_merge_unavailable_title()}</AlertTitle>
        <AlertDescription>
          <p>{reasonText(reason)}</p>
          <p>
            {conflict.error
              ? m.page_merge_not_in_git()
              : m.changes_conflict_whole_hint()}
          </p>
        </AlertDescription>
      </Alert>
      {conflict.problem ? (
        <ConflictProblemAlert problem={conflict.problem} />
      ) : null}
      {file ? (
        <div className="flex flex-wrap gap-2">
          <ConflictWholeFileAction
            file={file}
            side="ours"
            disabled={readOnly || conflict.pending}
            onConfirm={() => void conflict.takeSide("ours")}
          />
          <ConflictWholeFileAction
            file={file}
            side="theirs"
            disabled={readOnly || conflict.pending}
            onConfirm={() => void conflict.takeSide("theirs")}
          />
        </div>
      ) : null}
    </div>
  );
}
