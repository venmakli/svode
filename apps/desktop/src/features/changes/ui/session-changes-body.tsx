import { useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  refreshGitStatus,
  useGitConflictKinds,
  useGitStore,
  type GitStatus,
} from "@/features/git";
import { useSpace } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { useChangesAccordion } from "../hooks/use-changes-accordion";
import { useChangesStats } from "../hooks/use-changes-stats";
import type { ItemReader } from "../model/item-reader";
import type { ChangesTarget, InspectionScope } from "../model/scope";
import {
  sessionAreaParts,
  sessionWorkSpaces,
  type SessionArea,
  type SessionAreaPart,
} from "../model/session-scope";
import { ChangesBody } from "./changes-body";
import { ChangesItemList } from "./changes-item-list";
import { changesCount } from "./changes-toolbar";

/**
 * The "Changes" of a chat session (Stage 11 1.7): the uncommitted files of
 * its work, by repository when it changed more than one, and under them the
 * rest of its own Space with the way to that Space.
 */
export function SessionChangesBody({
  open,
  target,
  area,
  reader,
  onShowSpace,
}: {
  open: boolean;
  target: ChangesTarget;
  area: SessionArea;
  reader: ItemReader;
  onShowSpace: () => void;
}) {
  const statuses = useGitStore((state) => state.statuses);
  const errors = useGitStore((state) => state.statusErrors);
  const outside =
    area.outside > 0 ? (
      <div className="px-4 py-2">
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0"
          data-changes-session-outside
          onClick={onShowSpace}
        >
          {m.changes_session_outside({
            name: target.name,
            count: changesCount(
              area.outside,
              (statuses[target.spacePath]?.omittedFiles ?? 0) > 0,
            ),
          })}
        </Button>
      </div>
    ) : null;
  const parts = sessionAreaParts(area);
  // One Space of the work keeps the full list of a scope with its filter.
  const single = parts.length <= 1;
  const spacePath = parts[0]?.spacePath ?? target.spacePath;
  const scope = useMemo<InspectionScope>(
    () => ({ kind: "repository", spacePath, path: "" }),
    [spacePath],
  );
  if (single)
    return (
      <ChangesBody
        key={spacePath}
        open={open}
        scope={scope}
        status={statuses[spacePath]}
        error={errors[spacePath]}
        paths={parts[0]?.paths ?? []}
        reader={reader}
        name={m.changes_session_title()}
        after={outside}
      />
    );
  return (
    <SessionSections
      open={open}
      target={target}
      area={area}
      statuses={statuses}
      failed={sessionWorkSpaces(target).filter((path) => errors[path])}
      reader={reader}
      after={outside}
    />
  );
}

function SessionSections({
  open,
  target,
  area,
  statuses,
  failed,
  reader,
  after,
}: {
  open: boolean;
  target: ChangesTarget;
  area: SessionArea;
  statuses: Readonly<Record<string, GitStatus | undefined>>;
  failed: string[];
  reader: ItemReader;
  after: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const childSpaces = useSpace((state) => state.spaces);
  const nameOf = (spacePath: string) =>
    [...rootSpaces, ...childSpaces].find((space) => space.path === spacePath)
      ?.name ?? (spacePath === target.spacePath ? target.name : spacePath);
  return (
    <>
      <SheetHeader className="shrink-0 pt-3 pr-12">
        <div className="flex min-h-7 items-center gap-3">
          <SheetTitle>{m.changes_title()}</SheetTitle>
        </div>
        <SheetDescription className="truncate">
          {m.changes_session_title()}
        </SheetDescription>
      </SheetHeader>
      {open ? (
        <div
          ref={body}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          data-changes-body
        >
          {failed.map((spacePath) => (
            <Alert key={spacePath} className="mx-4 mb-2 w-auto">
              <AlertDescription>
                {nameOf(spacePath)}: {m.changes_repository_failed()}
              </AlertDescription>
              <Button
                variant="outline"
                onClick={() => void refreshGitStatus(spacePath)}
              >
                {m.changes_retry()}
              </Button>
            </Alert>
          ))}
          {area.sections.map((section) => (
            <section
              key={section.repository}
              aria-label={
                area.sections.length > 1
                  ? nameOf(section.parts[0].spacePath)
                  : undefined
              }
              data-changes-session-section={section.repository}
            >
              {area.sections.length > 1 ? (
                <h3
                  data-changes-session-repository
                  className="px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground"
                >
                  {nameOf(section.parts[0].spacePath)}
                </h3>
              ) : null}
              {section.parts.map((part) => (
                <SessionPart
                  key={part.spacePath}
                  body={body}
                  part={part}
                  name={nameOf(part.spacePath)}
                  status={statuses[part.spacePath]!}
                  reader={reader}
                />
              ))}
            </section>
          ))}
          {after}
        </div>
      ) : null}
    </>
  );
}

/** The uncommitted work of the session in one Space of a section. */
function SessionPart({
  body,
  part,
  name,
  status,
  reader,
}: {
  body: RefObject<HTMLDivElement | null>;
  part: SessionAreaPart;
  name: string;
  status: GitStatus;
  reader: ItemReader;
}) {
  const scope = useMemo<InspectionScope>(
    () => ({ kind: "repository", spacePath: part.spacePath, path: "" }),
    [part.spacePath],
  );
  const accordion = useChangesAccordion(part.paths, body);
  const stats = useChangesStats(scope, status, part.paths);
  const conflictKinds = useGitConflictKinds(part.spacePath, status);
  return (
    <div
      data-changes-session-part={part.spacePath}
      onFocusCapture={(event) => accordion.onFocus(event.target as HTMLElement)}
      onBlurCapture={(event) => accordion.onBlur(event.relatedTarget)}
    >
      <ChangesItemList
        accordion={accordion}
        scope={scope}
        status={status}
        stats={stats}
        reader={reader}
        ownerName={name}
        conflictKinds={conflictKinds}
      />
    </div>
  );
}
