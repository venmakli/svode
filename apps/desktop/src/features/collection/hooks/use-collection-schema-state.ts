import { useCallback, useEffect, useState } from "react";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import { getCollectionSchema } from "../api";

export function useCollectionSchemaState({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}) {
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [loading, setLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);

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

  return {
    schema,
    setSchema,
    loading,
    schemaError,
    refreshSchema: useCallback(() => reload({ background: true }), [reload]),
  };
}
