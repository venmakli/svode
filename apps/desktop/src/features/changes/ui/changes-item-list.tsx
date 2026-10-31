import { Accordion } from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import type { GitConflictKind, GitStatus } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import type { InspectionItemStats } from "../api/inspection";
import { useChangesItemNames } from "../hooks/use-changes-item-names";
import type { useChangesAccordion } from "../hooks/use-changes-accordion";
import type { ItemReader } from "../model/item-reader";
import type { InspectionScope } from "../model/scope";
import { ChangedItem } from "./changed-item";

/** The aggregate list of one scope: folded items, opened in place. */
export function ChangesItemList({
  accordion,
  scope,
  status,
  stats,
  reader,
  ownerName,
  conflictKinds,
}: {
  accordion: ReturnType<typeof useChangesAccordion>;
  scope: InspectionScope;
  status: GitStatus;
  stats: Record<string, InspectionItemStats>;
  reader: ItemReader;
  ownerName: string;
  conflictKinds?: ReadonlyMap<string, GitConflictKind>;
}) {
  const names = useChangesItemNames(scope.spacePath);
  const files = new Map(status.files.map((file) => [file.path, file]));
  return (
    <>
      <Accordion
        type="multiple"
        value={accordion.expanded}
        onValueChange={accordion.setExpanded}
        className="px-4"
      >
        {accordion.shown.map((path) => (
          <ChangedItem
            key={path}
            reader={reader}
            scope={scope}
            path={path}
            name={names.get(path) || itemName(path, scope, ownerName)}
            state={files.get(path)!.state}
            status={status}
            expanded={accordion.expanded.includes(path)}
            stats={stats[path]}
            conflictKind={conflictKinds?.get(path)}
          />
        ))}
      </Accordion>
      {accordion.remaining > 0 ? (
        <div className="p-4">
          <Button variant="outline" onClick={accordion.more}>
            {m.changes_more({ count: String(accordion.remaining) })}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function itemName(path: string, scope: InspectionScope, ownerName: string) {
  const parts = path.split("/");
  const file = parts.at(-1) ?? path;
  if (file.toLowerCase() === "readme.md")
    return parts.slice(0, -1).join("/") === scope.path
      ? ownerName
      : (parts.at(-2) ?? ownerName);
  return file.endsWith(".md") ? file.slice(0, -3).replaceAll("-", " ") : file;
}
