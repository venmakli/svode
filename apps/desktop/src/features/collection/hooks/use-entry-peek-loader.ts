import { useEffect, useState } from "react";
import { readEntry as readEntryApi } from "@/features/entry/entry-api";
import type { Entry } from "@/features/entry";
import { getEntrySchema } from "@/features/properties/api";
import {
  normalizeSchema,
  type EntrySchemaResult,
} from "@/features/properties";
import { handleError } from "../lib/errors";
import type { EntryPeekTarget } from "../model";

export function useEntryPeekLoader({
  target,
  spacePath,
}: {
  target: EntryPeekTarget | null;
  spacePath: string;
}) {
  const [entry, setEntry] = useState<Entry | null>(target?.entry ?? null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!target) {
      queueMicrotask(() => {
        if (!cancelled) {
          setEntry(null);
          setSchemaResult(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    queueMicrotask(() => {
      if (!cancelled) {
        setEntry(target.entry);
        setSchemaResult(null);
      }
    });

    if (target.nested) {
      return () => {
        cancelled = true;
      };
    }
    void Promise.all([
      readEntryApi({ spacePath, path: target.entry.path }),
      getEntrySchema({ spacePath, filePath: target.entry.path }).catch(
        () => null,
      ),
    ])
      .then(([nextEntry, nextSchemaResult]) => {
        if (cancelled) return;
        setEntry(nextEntry);
        setSchemaResult(
          nextSchemaResult
            ? {
                ...nextSchemaResult,
                schema: normalizeSchema(nextSchemaResult.schema),
              }
            : null,
        );
      })
      .catch(handleError);

    return () => {
      cancelled = true;
    };
  }, [spacePath, target]);

  return { entry, setEntry, schemaResult, setSchemaResult };
}
