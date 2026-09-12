import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import * as m from "@/paraglide/messages.js";
import type { CollectionPresentationLayout } from "@/features/collection";
import type { useAttachmentsSource } from "../hooks/use-attachments-source";
import type { AttachmentBranch } from "../model/source-session";
import type { AttachmentRow } from "../model/types";

export type AttachmentsSource = ReturnType<typeof useAttachmentsSource>;

export function attachmentHierarchy(
  source: AttachmentsSource,
): Extract<
  CollectionPresentationLayout<AttachmentRow>,
  { kind: "table" }
>["hierarchy"] {
  return {
    getLabel: (row) => row.displayName,
    onToggle: (row) => {
      if (row.ownerPath) source.toggle(row.ownerPath);
    },
    getBranch: (row) => {
      if (!row.ownerPath || row.sourceShape !== "directory") return null;
      if (row.hasChildren === false && !source.expanded.has(row.ownerPath))
        return null;
      const branch = source.branches.get(row.ownerPath);
      return {
        expanded: source.expanded.has(row.ownerPath),
        rows: branch?.snapshot?.rows ?? [],
        status:
          !branch ||
          branch.loading ||
          branch.error ||
          !branch.snapshot?.rows.length ||
          branch.snapshot.diagnostics.length ? (
            <AttachmentBranchStatus
              branch={branch}
              onRetry={() => void source.loadBranch(row.ownerPath!)}
            />
          ) : undefined,
      };
    },
  };
}

export function AttachmentBranchStatus({
  branch,
  onRetry,
}: {
  branch?: AttachmentBranch;
  onRetry(): void;
}) {
  return (
    <>
      {!branch || branch.loading ? <Skeleton className="h-6 w-48" /> : null}
      {branch?.error ? (
        <Alert variant="destructive">
          <AlertDescription>{branch.error}</AlertDescription>
          <Button size="sm" variant="outline" onClick={onRetry}>
            {m.attachments_retry()}
          </Button>
        </Alert>
      ) : null}
      {branch?.snapshot?.diagnostics.map((diagnostic) => (
        <Alert key={`${diagnostic.code}:${diagnostic.path}`}>
          <AlertDescription>
            {m.attachments_source_partial({ path: diagnostic.path })}
          </AlertDescription>
        </Alert>
      ))}
      {branch?.snapshot &&
      !branch.loading &&
      !branch.error &&
      branch.snapshot.rows.length === 0 ? (
        <Empty className="p-2">
          <EmptyHeader>
            <EmptyTitle>{m.attachments_branch_empty()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
    </>
  );
}
