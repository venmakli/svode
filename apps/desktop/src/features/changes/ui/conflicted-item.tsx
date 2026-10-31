import { lazy, Suspense, useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  conflictInPageEditor,
  conflictPageOpener,
  conflictResolvable,
  type GitConflictFile,
  type GitConflictKind,
  type GitConflictUnclearReason,
} from "@/features/git";
import * as m from "@/paraglide/messages.js";
import {
  useConflictFile,
  type ConflictFileProblem,
} from "../hooks/use-conflict-file";

const ConflictPlaces = lazy(() =>
  import("./conflict-places").then((module) => ({
    default: module.ConflictPlaces,
  })),
);

/**
 * The body of a conflicted file in "Changes" (1.F): a Page leads to its
 * editor, a text file is resolved by places or, when they are not told
 * apart, by the version of a side for the whole file.
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
  if (conflictInPageEditor(path, kind)) {
    const open = conflictPageOpener({ spacePath, path });
    return (
      <Message>
        {m.changes_conflict_page()}
        {open ? (
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0"
            onClick={open}
            data-conflict-open-editor
          >
            {m.changes_conflict_open_editor()}
          </Button>
        ) : null}
      </Message>
    );
  }
  if (
    !conflictResolvable(path) ||
    (kind !== undefined && kind !== "text" && kind !== "add_add")
  )
    return <InGit onReveal={onReveal} />;
  return (
    <ConflictTextFile spacePath={spacePath} path={path} onReveal={onReveal} />
  );
}

function ConflictTextFile({
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
  if (!file.places || (file.content === null && file.places.type === "places"))
    return <InGit onReveal={onReveal} />;
  const problem = conflict.problem ? (
    <ProblemAlert problem={conflict.problem} />
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
          onChoose={conflict.choose}
        />
      </Suspense>
    </div>
  );
}

/**
 * «Оставить моё» or «Взять входящее» for the whole file, with the
 * confirmation that names what is lost; unavailable without that side.
 */
function WholeFileAction({
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
  const [open, setOpen] = useState(false);
  const available = side === "ours" ? file.ours : file.theirs;
  const copy =
    side === "ours"
      ? {
          action: m.changes_conflict_keep_ours(),
          title: m.changes_conflict_keep_ours_title(),
          description: m.changes_conflict_keep_ours_description(),
        }
      : {
          action: m.changes_conflict_take_theirs(),
          title: m.changes_conflict_take_theirs_title(),
          description: m.changes_conflict_take_theirs_description(),
        };
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !available}
          title={available ? undefined : m.changes_conflict_side_missing()}
          data-conflict-whole={side}
        >
          {copy.action}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.changes_conflict_back()}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {copy.action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ProblemAlert({ problem }: { problem: ConflictFileProblem }) {
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
          : m.changes_conflict_unreadable_title()}
      </AlertTitle>
      <AlertDescription className="whitespace-pre-wrap break-words">
        {problem.kind === "failed"
          ? problem.message
          : problem.finding.type === "unreadable"
            ? m.changes_conflict_unreadable({
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

function unclearReason(reason: GitConflictUnclearReason) {
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
