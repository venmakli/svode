import { lazy, Suspense } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  conflictInPageEditor,
  conflictPageOpener,
  type GitConflictFile,
  type GitConflictKind,
  type GitConflictUnclearReason,
} from "@/features/git";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import {
  useConflictFile,
  type ConflictFileProblem,
} from "../hooks/use-conflict-file";
import { conflictSidesText } from "../lib/conflict-sides";
import { ConflictResolveButton } from "./conflict-resolve-button";

const ConflictPlaces = lazy(() =>
  import("./conflict-places").then((module) => ({
    default: module.ConflictPlaces,
  })),
);

/**
 * The body of a conflicted file in "Changes" (1.F): a text file, a Page
 * included (DF-294), is resolved by places or, when they are not told
 * apart, by the version of a side for the whole file, and a file without
 * markers by the actions of its kind. A Page also leads to its editor.
 */
export function ConflictedItem({
  spacePath,
  path,
  kind,
  onReveal,
}: {
  spacePath: string;
  path: string;
  kind: GitConflictKind | undefined;
  onReveal: () => void;
}) {
  if (kind === "space_pointer") return <InGit onReveal={onReveal} />;
  return (
    <ConflictFileBody spacePath={spacePath} path={path} onReveal={onReveal} />
  );
}

function ConflictFileBody({
  spacePath,
  path,
  onReveal,
}: {
  spacePath: string;
  path: string;
  onReveal: () => void;
}) {
  const conflict = useConflictFile(spacePath, path);
  const { file } = conflict;
  if (conflict.error)
    return (
      <Alert className="mx-4 w-auto">
        <AlertDescription>{m.changes_load_failed()}</AlertDescription>
        <Button variant="outline" onClick={conflict.retry}>
          {m.changes_retry()}
        </Button>
      </Alert>
    );
  if (conflict.loading || !file) return <Skeleton className="m-4 h-32" />;
  if (file.changes)
    return <WholeFile file={file} changes={file.changes} conflict={conflict} />;
  if (!file.places || (file.content === null && file.places.type === "places"))
    return <InGit onReveal={onReveal} />;
  const keepBoth =
    file.kind === "add_add" ? (
      <ConflictResolveButton
        label={m.changes_conflict_keep_both()}
        disabled={conflict.pending}
        onRun={() => void conflict.keepBoth()}
        data-conflict-action="keep_both"
      />
    ) : null;
  const problem = conflict.problem ? (
    <ProblemAlert problem={conflict.problem} />
  ) : null;
  // A Page is also resolved in its editor (DF-294 R1).
  const openPage = conflictInPageEditor(path, file.kind)
    ? conflictPageOpener({ spacePath, path })
    : undefined;
  const openEditor = (className?: string) =>
    openPage ? (
      <Button
        variant="link"
        size="sm"
        className={cn("h-auto px-0", className)}
        onClick={openPage}
        data-conflict-open-editor
      >
        {m.changes_conflict_open_editor()}
      </Button>
    ) : null;
  if (file.places.type === "unclear")
    return (
      <div className="flex min-w-0 flex-col gap-3 px-4">
        <Alert data-conflict-unclear={file.places.reason}>
          <TriangleAlert />
          <AlertTitle>{m.changes_conflict_unclear_title()}</AlertTitle>
          <AlertDescription>
            <p>{unclearReason(file.places.reason)}</p>
            <p>{m.changes_conflict_whole_hint()}</p>
          </AlertDescription>
        </Alert>
        {problem}
        <div className="flex flex-wrap gap-2">
          <WholeFileAction
            file={file}
            side="ours"
            disabled={conflict.pending}
            onConfirm={() => void conflict.takeSide("ours")}
          />
          <WholeFileAction
            file={file}
            side="theirs"
            disabled={conflict.pending}
            onConfirm={() => void conflict.takeSide("theirs")}
          />
          {keepBoth}
          {openEditor("ml-auto")}
        </div>
      </div>
    );
  const places = file.places.places;
  return (
    <div className="flex min-w-0 flex-col gap-3" aria-busy={conflict.pending}>
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="mr-auto text-xs text-muted-foreground">
          {m.changes_conflict_remaining()}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={conflict.pending}
          onClick={() => conflict.chooseRemaining("ours")}
          data-conflict-remaining="ours"
        >
          {m.changes_conflict_keep_ours()}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={conflict.pending}
          onClick={() => conflict.chooseRemaining("theirs")}
          data-conflict-remaining="theirs"
        >
          {m.changes_conflict_take_theirs()}
        </Button>
        {keepBoth}
        {openEditor()}
      </div>
      {problem ? <div className="px-4">{problem}</div> : null}
      <Suspense fallback={<Skeleton className="m-4 h-32" />}>
        <ConflictPlaces
          path={path}
          version={file.version}
          content={file.content ?? ""}
          places={places}
          choices={conflict.choices}
          disabled={conflict.pending}
          // Both sides in the frontmatter would repeat its keys (DF-294 R2).
          allowsBoth={(place) => !places[place]?.frontmatter}
          onChoose={conflict.choose}
          onReopen={conflict.reopen}
        />
      </Suspense>
    </div>
  );
}

/**
 * «Оставить моё» or «Взять входящее» for the whole file, with the
 * confirmation that names what is lost; unavailable without that side.
 */
export function WholeFileAction({
  file,
  side,
  disabled,
  onConfirm,
}: {
  file: GitConflictFile;
  side: "ours" | "theirs";
  disabled: boolean;
  onConfirm: () => void;
}) {
  const available = side === "ours" ? file.ours : file.theirs;
  return (
    <ConflictResolveButton
      label={
        side === "ours"
          ? m.changes_conflict_keep_ours()
          : m.changes_conflict_take_theirs()
      }
      confirm={
        side === "ours"
          ? {
              title: m.changes_conflict_keep_ours_title(),
              description: m.changes_conflict_keep_ours_description(),
            }
          : {
              title: m.changes_conflict_take_theirs_title(),
              description: m.changes_conflict_take_theirs_description(),
            }
      }
      disabled={disabled || !available}
      title={available ? undefined : m.changes_conflict_side_missing()}
      onRun={onConfirm}
      data-conflict-whole={side}
    />
  );
}

/**
 * A file without markers (1.F): a line on what each side did with it and
 * the actions of its kind; an action that discards my version confirms.
 */
function WholeFile({
  file,
  changes,
  conflict,
}: {
  file: GitConflictFile;
  changes: NonNullable<GitConflictFile["changes"]>;
  conflict: ReturnType<typeof useConflictFile>;
}) {
  const disabled = conflict.pending;
  // The side that still has the file in an edit or rename against a deletion.
  const kept = file.ours ? "ours" : "theirs";
  const remove = (
    <ConflictResolveButton
      label={m.changes_conflict_delete()}
      // Only my edited or renamed file is lost by the deletion.
      confirm={
        file.ours
          ? {
              title: m.changes_conflict_delete_title(),
              description: m.changes_conflict_delete_description(),
            }
          : undefined
      }
      disabled={disabled}
      onRun={() => void conflict.remove()}
      data-conflict-action="delete"
    />
  );
  const actions =
    file.kind === "modify_delete" ? (
      <>
        <ConflictResolveButton
          label={m.changes_conflict_keep_edited()}
          disabled={disabled}
          onRun={() => void conflict.takeSide(kept)}
          data-conflict-action="keep_edited"
        />
        {remove}
      </>
    ) : file.kind === "rename_delete" ? (
      <>
        <ConflictResolveButton
          label={m.changes_conflict_keep_new_name()}
          disabled={disabled}
          onRun={() => void conflict.takeSide(kept)}
          data-conflict-action="keep_new_name"
        />
        {remove}
      </>
    ) : file.kind === "rename_rename" ? (
      <>
        <ConflictResolveButton
          label={m.changes_conflict_keep_my_name()}
          disabled={disabled}
          onRun={() => void conflict.takeSide("ours")}
          data-conflict-action="keep_my_name"
        />
        <ConflictResolveButton
          label={m.changes_conflict_take_incoming_name()}
          confirm={{
            title: m.changes_conflict_take_incoming_name_title(),
            description: m.changes_conflict_take_incoming_name_description({
              ours: changes.ours.path ?? "",
              theirs: changes.theirs.path ?? "",
            }),
          }}
          disabled={disabled}
          onRun={() => void conflict.takeSide("theirs")}
          data-conflict-action="take_incoming_name"
        />
      </>
    ) : (
      <>
        <ConflictResolveButton
          label={m.changes_conflict_keep_ours()}
          disabled={disabled}
          onRun={() => void conflict.takeSide("ours")}
          data-conflict-action="keep_ours"
        />
        <ConflictResolveButton
          label={m.changes_conflict_take_theirs()}
          confirm={{
            title: m.changes_conflict_take_theirs_title(),
            description: m.changes_conflict_take_theirs_whole_description(),
          }}
          disabled={disabled}
          onRun={() => void conflict.takeSide("theirs")}
          data-conflict-action="take_theirs"
        />
        <ConflictResolveButton
          label={m.changes_conflict_keep_both()}
          disabled={disabled}
          onRun={() => void conflict.keepBoth()}
          data-conflict-action="keep_both"
        />
      </>
    );
  return (
    <div className="flex min-w-0 flex-col gap-3 px-4" aria-busy={disabled}>
      <p
        className="break-words text-sm text-muted-foreground"
        data-conflict-sides
      >
        {conflictSidesText(changes)}
      </p>
      {conflict.problem ? <ProblemAlert problem={conflict.problem} /> : null}
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function ProblemAlert({ problem }: { problem: ConflictFileProblem }) {
  if (problem.kind === "finding" && problem.finding.type === "changed")
    return (
      <Alert data-conflict-problem="changed">
        <AlertDescription>{m.changes_conflict_changed()}</AlertDescription>
      </Alert>
    );
  return (
    <Alert
      variant="destructive"
      data-conflict-problem={
        problem.kind === "failed" ? "failed" : problem.finding.type
      }
    >
      <TriangleAlert />
      <AlertTitle>
        {problem.kind === "failed"
          ? m.changes_conflict_failed()
          : problem.finding.type === "lfs_object"
            ? m.changes_conflict_lfs_object_title()
            : m.changes_conflict_unreadable_title()}
      </AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words">
        {problem.kind === "failed"
          ? problem.message
          : problem.finding.type === "unreadable"
            ? m.changes_conflict_unreadable({
                message: problem.finding.message,
              })
            : problem.finding.type === "lfs_object"
              ? m.changes_conflict_lfs_object({
                  message: problem.finding.message,
                })
              : m.changes_conflict_markers()}
      </AlertDescription>
    </Alert>
  );
}

function InGit({ onReveal }: { onReveal: () => void }) {
  return (
    <>
      <Message>{m.changes_conflict_in_git()}</Message>
      <div className="px-4">
        <Button variant="outline" size="sm" onClick={onReveal}>
          {m.changes_reveal()}
        </Button>
      </div>
    </>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle className="flex flex-col items-center gap-2">
          {children}
        </EmptyTitle>
      </EmptyHeader>
    </Empty>
  );
}

export function unclearReason(reason: GitConflictUnclearReason) {
  switch (reason) {
    case "ambiguous":
      return m.changes_conflict_unclear_ambiguous();
    case "broken":
      return m.changes_conflict_unclear_broken();
    case "no_markers":
      return m.changes_conflict_unclear_no_markers();
    case "too_large":
      return m.changes_conflict_unclear_too_large();
  }
}
