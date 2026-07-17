import { useCallback, useEffect, useState } from "react";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import { getCollectionSchema, updateCollectionDocumentLabel } from "../api";

export function useCollectionSchemaState({
  spacePath,
  collectionPath,
  projectPath,
}: {
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
}) {
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [documentLabel, setDocumentLabel] = useState("");

  const reload = useCallback(
    async (options?: { background?: boolean }) => {
      const background = Boolean(options?.background);
      if (!background) setLoading(true);
      setSchemaError(null);
      try {
        const nextSchema = await getCollectionSchema({
          spacePath,
          collectionPath,
        });
        setSchema(normalizeSchema(nextSchema));
      } catch (error) {
        console.error("Failed to load collection:", error);
        setSchemaError(String(error));
      } finally {
        if (!background) setLoading(false);
      }
    },
    [collectionPath, spacePath],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    queueMicrotask(() => {
      setDocumentLabel(schema?.document?.label ?? m.collection_document_tab());
    });
  }, [schema]);

  const saveDocumentLabel = useCallback(async () => {
    const next = await updateCollectionDocumentLabel({
      spacePath,
      collectionPath,
      label: documentLabel.trim() || null,
      projectPath,
    });
    setSchema(normalizeSchema(next));
  }, [collectionPath, documentLabel, projectPath, spacePath]);

  return {
    schema,
    setSchema,
    loading,
    schemaError,
    documentLabel,
    setDocumentLabel,
    saveDocumentLabel,
    refreshSchema: useCallback(() => reload({ background: true }), [reload]),
  };
}
