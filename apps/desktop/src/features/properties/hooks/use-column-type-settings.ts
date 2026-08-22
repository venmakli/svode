import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import {
  normalizeUniqueIdCounter,
  updateSchemaColumn,
} from "../api/schema-api";
import { propertyErrorMessage } from "../lib/error-message";
import type { CollectionSchema, Column, ColumnPatch } from "../model/types";

interface UseColumnTypeSettingsInput {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
}

export function useColumnTypeSettings({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
}: UseColumnTypeSettingsInput) {
  const identity = `${spacePath}\u0000${collectionPath}\u0000${projectPath ?? ""}\u0000${column.name}`;
  const identityRef = useRef(identity);
  const requestGenerationRef = useRef(0);
  const [pendingIdentity, setPendingIdentity] = useState<string | null>(null);
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    requestGenerationRef.current += 1;
  }

  const handleError = useCallback((error: unknown) => {
    console.error(error);
    toast.error(propertyErrorMessage(error));
  }, []);

  const runMutation = useCallback(
    async (mutation: () => Promise<CollectionSchema>) => {
      const requestIdentity = identity;
      const requestGeneration = ++requestGenerationRef.current;
      setPendingIdentity(requestIdentity);
      try {
        const next = await mutation();
        if (
          identityRef.current === requestIdentity &&
          requestGenerationRef.current === requestGeneration
        ) {
          onSchemaChange(next);
        }
      } catch (error) {
        if (
          identityRef.current === requestIdentity &&
          requestGenerationRef.current === requestGeneration
        ) {
          handleError(error);
        }
      } finally {
        if (
          identityRef.current === requestIdentity &&
          requestGenerationRef.current === requestGeneration
        ) {
          setPendingIdentity(null);
        }
      }
    },
    [handleError, identity, onSchemaChange],
  );

  const patchColumn = useCallback(
    async (patch: ColumnPatch) => {
      await runMutation(() =>
        updateSchemaColumn({
          spacePath,
          collectionPath,
          columnName: column.name,
          patch,
          projectPath,
        }),
      );
    },
    [collectionPath, column.name, projectPath, runMutation, spacePath],
  );

  const normalizeCounter = useCallback(() => {
    void runMutation(() =>
      normalizeUniqueIdCounter({
        spacePath,
        collectionPath,
        projectPath,
      }),
    );
  }, [collectionPath, projectPath, runMutation, spacePath]);

  return {
    patchColumn,
    normalizeCounter,
    pending: pendingIdentity === identity,
  };
}
