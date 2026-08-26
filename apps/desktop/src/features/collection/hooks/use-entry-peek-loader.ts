import { useEffect, useState } from "react";
import { readEntry as readEntryApi } from "@/features/entry/entry-api";
import { applyEntryTitleOutcome, type Entry } from "@/features/entry";
import {
  useEntryTitleOutcomeEffect,
  useRetargetEntryDocument,
} from "@/features/entry/selection";
import { getEntrySchema } from "@/features/properties/api";
import { normalizeSchema, type EntrySchemaResult } from "@/features/properties";
import { handleError } from "./error-feedback";
import type { EntryPeekTarget } from "../model";

export function useEntryPeekLoader({
  target,
  spacePath,
  spaceId,
}: {
  target: EntryPeekTarget | null;
  spacePath: string;
  spaceId: string;
}) {
  const [entry, setEntry] = useState<Entry | null>(target?.entry ?? null);
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const [pathHandoff, setPathHandoff] = useState<{
    previousPath: string;
    path: string;
  } | null>(null);
  const retargetDocument = useRetargetEntryDocument();
  const targetKey = target
    ? entryPeekTargetKey(spacePath, target.entry.path)
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!target) {
      queueMicrotask(() => {
        if (!cancelled) {
          setEntry(null);
          setSchemaResult(null);
          setLoadedTargetKey(null);
          setPathHandoff(null);
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
        setLoadedTargetKey(targetKey);
        setPathHandoff(null);
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
  }, [spacePath, target, targetKey]);

  useEntryTitleOutcomeEffect({
    scopePath: spacePath,
    path: entry?.path ?? target?.entry.path ?? null,
    onOutcome: (titleOutcome) => {
      setEntry((current) =>
        current ? applyEntryTitleOutcome(current, titleOutcome.entry) : current,
      );
      if (titleOutcome.previousPath === titleOutcome.entry.path) return;
      setPathHandoff({
        previousPath: titleOutcome.previousPath,
        path: titleOutcome.entry.path,
      });
      retargetDocument(
        titleOutcome.previousPath,
        titleOutcome.entry.path,
        spaceId,
      );
    },
  });

  return {
    entry,
    setEntry,
    schemaResult,
    setSchemaResult,
    loadedTargetKey,
    pathHandoff,
    targetKey,
  };
}

export function entryPeekTargetKey(spacePath: string, entryPath: string) {
  return `${spacePath.replaceAll("\\", "/").replace(/\/+$/g, "")}\0${entryPath.replaceAll("\\", "/")}`;
}

export function resolveLoadedPeekEntry(
  target: EntryPeekTarget | null,
  entry: Entry | null,
  loadedTargetKey: string | null,
  targetKey: string | null,
) {
  return target && loadedTargetKey === targetKey ? entry : null;
}
