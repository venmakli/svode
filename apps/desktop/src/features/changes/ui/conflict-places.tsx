import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
} from "react";
import { File, UnresolvedFile } from "@pierre/diffs/react";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/components/ui/theme-provider";
import type { GitConflictPlace, GitPlaceChoice } from "@/features/git";
import { cn } from "@/shared/lib/utils";
import * as m from "@/paraglide/messages.js";
import {
  conflictDisplay,
  type ChosenPlaceDisplay,
} from "../lib/conflict-display";

/**
 * The places of a text file in conflict in `UnresolvedFile` (DF-291): each
 * open place has «Принять моё · Принять входящее · Принять оба» in its action
 * slot, and a place with a choice shows the text of that side with a mark of
 * the choice and «Изменить» as a line annotation. The places and the shown
 * text are Svode's (DF-238); the component only shows them. Without an open
 * place the text is shown as a plain file with the same marks.
 */
export function ConflictPlaces({
  path,
  version,
  content,
  places,
  choices,
  disabled,
  allowsBoth = everyPlace,
  onChoose,
  onReopen,
}: {
  path: string;
  version: string;
  content: string;
  places: readonly GitConflictPlace[];
  choices: readonly (GitPlaceChoice | null)[];
  disabled: boolean;
  /** Whether «Принять оба» is offered at a place; at every place by default. */
  allowsBoth?: (place: number) => boolean;
  onChoose: (place: number, choice: GitPlaceChoice) => void;
  /** «Изменить»: the place is open again with both sides and its actions. */
  onReopen: (place: number) => void;
}) {
  const { theme } = useTheme();
  const display = useMemo(
    () =>
      conflictDisplay(content, places, choices, {
        ours: m.changes_conflict_ours(),
        theirs: m.changes_conflict_theirs(),
      }),
    [choices, content, places],
  );
  // The component reads its file once: other choices are another file.
  const cacheKey = `${path}:${version}:${choices.map((choice) => choice ?? "").join(",")}`;
  const file = useMemo(
    () => ({ name: path, contents: display.text, cacheKey }),
    [cacheKey, display.text, path],
  );
  const options = useMemo(
    () => ({
      themeType: theme,
      overflow: "wrap" as const,
      disableFileHeader: true,
      // A place with a choice stays in view however far from an open one.
      expandUnchanged: true,
    }),
    [theme],
  );
  // Every choice rebuilds the view: the keyboard stays at its place.
  const root = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  useEffect(() => {
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target) root.current?.querySelector<HTMLElement>(target)?.focus();
  }, [cacheKey]);
  const choose = (place: number, choice: GitPlaceChoice) => {
    focusAfter.current = `[data-conflict-reopen="${place}"]`;
    onChoose(place, choice);
  };
  const reopen = (place: number) => {
    focusAfter.current = `[data-conflict-place="${place}"] button`;
    onReopen(place);
  };
  const accepted = (chosen: ChosenPlaceDisplay | undefined) =>
    chosen ? (
      <AcceptedPlace
        chosen={chosen}
        disabled={disabled}
        onReopen={() => reopen(chosen.place)}
      />
    ) : null;

  return (
    <div ref={root} className="min-w-0">
      {display.open.length === 0 ? (
        <File
          key={cacheKey}
          file={file}
          options={options}
          lineAnnotations={display.chosen.map((chosen) => ({
            lineNumber: chosen.lineNumber,
            metadata: chosen,
          }))}
          renderAnnotation={(annotation) => accepted(annotation.metadata)}
        />
      ) : (
        <UnresolvedFile
          key={cacheKey}
          file={file}
          options={options}
          lineAnnotations={display.chosen.map((chosen) => ({
            side: "additions" as const,
            lineNumber: chosen.lineNumber,
            metadata: chosen,
          }))}
          renderAnnotation={(annotation) => accepted(annotation.metadata)}
          renderMergeConflictUtility={(action) => {
            const place = display.open[action.conflictIndex];
            return place === undefined ? null : (
              <PlaceActions
                place={place}
                both={allowsBoth(place)}
                disabled={disabled}
                onChoose={(choice) => choose(place, choice)}
              />
            );
          }}
        />
      )}
    </div>
  );
}

const everyPlace = () => true;

/** The actions of an open place, in the grammar of the component's own. */
function PlaceActions({
  place,
  both,
  disabled,
  onChoose,
}: {
  place: number;
  both: boolean;
  disabled: boolean;
  onChoose: (choice: GitPlaceChoice) => void;
}) {
  const actions: [GitPlaceChoice, string][] = [
    ["ours", m.changes_conflict_accept_ours()],
    ["theirs", m.changes_conflict_accept_theirs()],
  ];
  if (both) actions.push(["both", m.changes_conflict_accept_both()]);
  return (
    <div
      role="group"
      aria-label={m.changes_conflict_place({ index: String(place + 1) })}
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-conflict-place={place}
    >
      {actions.map(([choice, label], at) => (
        <Fragment key={choice}>
          {at > 0 ? <ActionSeparator /> : null}
          <TextAction
            disabled={disabled}
            onClick={() => onChoose(choice)}
            className={
              choice === "ours"
                ? "hover:text-(--diffs-addition-base)"
                : choice === "theirs"
                  ? "hover:text-(--diffs-modified-base)"
                  : undefined
            }
            data-conflict-choice={choice}
          >
            {label}
          </TextAction>
        </Fragment>
      ))}
    </div>
  );
}

/** A place with a choice: the mark of the side and «Изменить». */
function AcceptedPlace({
  chosen,
  disabled,
  onReopen,
}: {
  chosen: ChosenPlaceDisplay;
  disabled: boolean;
  onReopen: () => void;
}) {
  return (
    <div
      role="group"
      aria-label={m.changes_conflict_place({
        index: String(chosen.place + 1),
      })}
      className="flex min-h-7 min-w-0 flex-wrap items-center gap-1 px-2 [font-family:var(--diffs-header-font-family,var(--diffs-header-font-fallback))] text-xs leading-tight whitespace-normal text-(--diffs-fg-number)"
      data-conflict-accepted={chosen.choice}
      data-conflict-place-accepted={chosen.place}
    >
      <span>
        {chosen.choice === "ours"
          ? m.changes_conflict_accepted_ours()
          : chosen.choice === "theirs"
            ? m.changes_conflict_accepted_theirs()
            : m.changes_conflict_accepted_both()}
      </span>
      <ActionSeparator />
      <TextAction
        disabled={disabled}
        onClick={onReopen}
        data-conflict-reopen={chosen.place}
      >
        {m.changes_conflict_change_choice()}
      </TextAction>
    </div>
  );
}

function TextAction({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="link"
      size="xs"
      className={cn(
        "h-auto rounded-sm px-0 text-xs font-normal text-(--diffs-fg-number) hover:text-(--diffs-fg) hover:no-underline",
        className,
      )}
      {...props}
    />
  );
}

function ActionSeparator() {
  return (
    <span aria-hidden className="select-none opacity-60">
      |
    </span>
  );
}
