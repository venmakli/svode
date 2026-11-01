import { useId } from "react";
import { Check, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ConflictProblemAlert,
  ConflictWholeFileAction,
  conflictUnclearReason,
  useConflictFile,
} from "@/features/changes";
import type { GitConflictUnclearReason } from "@/features/git";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";

import {
  ConflictLane,
  ConflictLanes,
  ConflictLines,
} from "../conflict/conflict-lanes";
import { usePropertiesConflict } from "../hooks/use-properties-conflict";
import type {
  PropertiesResolution,
  PropertiesSide,
} from "../model/properties-conflict";

/**
 * «Конфликт в свойствах» above the text of a Page (1.F): the lines of both
 * sides of every place in its frontmatter as they are, with «Моё» or
 * «Входящее»; a place Svode cannot tell apart leaves the version of a side
 * for the whole file. The Page is not saved until the block is resolved.
 * When the frontmatter opens in a place from the first line, as when both
 * sides added the Page, its places open the text as conflict places of the
 * text (DF-293 R6): the lines of the sides as they are, «Принять моё» or
 * «Принять входящее», never both.
 */
export function PropertiesConflictBlock({
  documentKey,
  spacePath,
  path,
  readOnly,
  onResolved,
  className,
}: {
  documentKey: string;
  spacePath: string;
  path: string;
  readOnly: boolean;
  onResolved: () => void;
  className?: string;
}) {
  const titleId = useId();
  const { state, choose } = usePropertiesConflict(documentKey, onResolved);
  if (!state) return null;
  const { conflict, choices, resolution } = state;
  if (conflict.opensInPlace && !conflict.unclear)
    return (
      <div data-properties-conflict-in-text className={cn("pt-1", className)}>
        {conflict.places.map((place, index) => (
          <div key={place.startLine} data-properties-place={index}>
            <ConflictLanes
              disabled={readOnly}
              actions={(["ours", "theirs"] as const).map((side) => ({
                key: side,
                side,
                label:
                  side === "ours"
                    ? m.changes_conflict_accept_ours()
                    : m.changes_conflict_accept_theirs(),
                pressed: choices[index] === side,
                onSelect: () => void choose(index, side),
              }))}
            >
              {(["ours", "theirs"] as const).map((side) => (
                <ConflictLane
                  key={side}
                  side={side}
                  dimmed={choices[index] !== null && choices[index] !== side}
                >
                  <ConflictLines>{place[side]}</ConflictLines>
                </ConflictLane>
              ))}
            </ConflictLanes>
          </div>
        ))}
        <ResolutionProblem resolution={resolution} />
      </div>
    );
  return (
    <section
      role="group"
      aria-labelledby={titleId}
      data-properties-conflict
      className={cn("pt-1 pb-3", className)}
    >
      <div className="rounded-md border border-yellow-600/40 bg-yellow-50/40 dark:bg-yellow-950/20">
        <div className="p-2 text-xs">
          <div
            id={titleId}
            className="font-medium text-yellow-700 dark:text-yellow-400"
          >
            ⚠ {m.editor_properties_conflict_title()}
          </div>
          <p className="mt-1 text-muted-foreground">
            {conflict.unclear
              ? m.editor_properties_conflict_unclear_description()
              : m.editor_properties_conflict_description()}
          </p>
        </div>
        {conflict.unclear ? (
          <WholeFile
            spacePath={spacePath}
            path={path}
            reason={conflict.unclear}
            readOnly={readOnly}
          />
        ) : (
          <>
            {conflict.places.map((place, index) => (
              <div
                key={place.startLine}
                className="border-t border-yellow-600/40 p-3"
                data-properties-place={index}
              >
                {conflict.places.length > 1 ? (
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    {m.changes_conflict_place({ index: String(index + 1) })}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  <PlaceSide
                    side="ours"
                    lines={place.ours}
                    choice={choices[index]}
                    disabled={readOnly}
                    onChoose={() => void choose(index, "ours")}
                  />
                  <PlaceSide
                    side="theirs"
                    lines={place.theirs}
                    choice={choices[index]}
                    disabled={readOnly}
                    onChoose={() => void choose(index, "theirs")}
                  />
                </div>
              </div>
            ))}
            <ResolutionStatus resolution={resolution} />
          </>
        )}
      </div>
    </section>
  );
}

function PlaceSide({
  side,
  lines,
  choice,
  disabled,
  onChoose,
}: {
  side: PropertiesSide;
  lines: string;
  choice: PropertiesSide | null;
  disabled: boolean;
  onChoose: () => void;
}) {
  const chosen = choice === side;
  return (
    <div
      className={cn(
        "rounded border border-yellow-600/30 bg-background/60",
        choice !== null && !chosen && "opacity-60",
      )}
      data-properties-side={side}
      data-chosen={chosen || undefined}
    >
      <div className="flex justify-end p-1.5 pb-0">
        <Button
          size="sm"
          variant={chosen ? "default" : "outline"}
          aria-pressed={chosen}
          disabled={disabled}
          onClick={onChoose}
        >
          {chosen ? <Check /> : null}
          {side === "ours"
            ? m.changes_conflict_ours()
            : m.changes_conflict_theirs()}
        </Button>
      </div>
      <pre className="overflow-x-auto px-3 pb-3 font-mono text-sm whitespace-pre">
        {lines}
      </pre>
    </div>
  );
}

/**
 * Why the choices in the places of the frontmatter shown in the text do not
 * give a frontmatter that reads; the choices stay.
 */
function ResolutionProblem({
  resolution,
}: {
  resolution: PropertiesResolution;
}) {
  if (resolution.status === "unresolved")
    return (
      <ConflictProblemAlert
        problem={{ kind: "finding", finding: resolution.finding }}
      />
    );
  if (resolution.status === "failed")
    return (
      <ConflictProblemAlert
        problem={{ kind: "failed", message: resolution.message }}
      />
    );
  return null;
}

function ResolutionStatus({
  resolution,
}: {
  resolution: PropertiesResolution;
}) {
  switch (resolution.status) {
    case "choosing":
    case "checking":
      return null;
    case "resolved":
      return (
        <p
          className="border-t border-yellow-600/40 p-3 text-xs text-muted-foreground"
          data-properties-resolved
        >
          {m.editor_properties_conflict_chosen()}
        </p>
      );
    case "unresolved":
      return (
        <div className="border-t border-yellow-600/40 p-3">
          <ConflictProblemAlert
            problem={{ kind: "finding", finding: resolution.finding }}
          />
        </div>
      );
    case "failed":
      return (
        <div className="border-t border-yellow-600/40 p-3">
          <ConflictProblemAlert
            problem={{ kind: "failed", message: resolution.message }}
          />
        </div>
      );
  }
}

/**
 * Places Svode cannot tell apart (1.F, item 7): «Оставить моё» or «Взять
 * входящее» for the whole Page from the index stages, with confirmation.
 */
function WholeFile({
  spacePath,
  path,
  reason,
  readOnly,
}: {
  spacePath: string;
  path: string;
  reason: GitConflictUnclearReason;
  readOnly: boolean;
}) {
  const conflict = useConflictFile(spacePath, path);
  const { file } = conflict;
  return (
    <div className="flex flex-col gap-3 border-t border-yellow-600/40 p-3">
      <Alert data-conflict-unclear={reason}>
        <TriangleAlert />
        <AlertTitle>{m.changes_conflict_unclear_title()}</AlertTitle>
        <AlertDescription>
          <p>{conflictUnclearReason(reason)}</p>
          <p>{m.changes_conflict_whole_hint()}</p>
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
      ) : conflict.error ? (
        <p className="text-xs text-muted-foreground">
          {m.editor_properties_conflict_not_in_git()}
        </p>
      ) : null}
    </div>
  );
}
