import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { conflictFileOpener } from "@/features/git/app-shell";
import * as m from "@/paraglide/messages.js";

/**
 * In place of the views while the schema of the Collection is in conflict
 * after a sync (1.F): «Разрешить» opens "Changes" at `schemaPath`. The item
 * files are not read or changed meanwhile.
 */
export function SchemaConflict({
  spacePath,
  schemaPath,
}: {
  spacePath: string;
  schemaPath: string;
}) {
  const resolve = conflictFileOpener({ spacePath, path: schemaPath });
  return (
    <div className="flex min-h-full flex-col">
      <Empty data-collection-schema-conflict>
        <EmptyHeader>
          <EmptyTitle>{m.collection_schema_conflict_title()}</EmptyTitle>
        </EmptyHeader>
        {resolve ? (
          <EmptyContent>
            <Button onClick={resolve}>
              {m.collection_schema_conflict_resolve()}
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    </div>
  );
}
