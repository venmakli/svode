import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { normalizeSchema, type CollectionSchema } from "@/features/properties";
import { getCollectionSchema } from "../api";

export function useCollectionSchemaState({
  spacePath,
  collectionPath,
}: {
  spacePath: string;
  collectionPath: string;
}) {
  const targetKey = `${spacePath}\u0000${collectionPath}`;
  const activeTargetRef = useRef(targetKey);
  const loadGenerationRef = useRef(0);
  const [state, setState] = useState<{
    targetKey: string;
    schema: CollectionSchema | null;
    loading: boolean;
    schemaError: string | null;
  }>({ targetKey, schema: null, loading: true, schemaError: null });
  if (activeTargetRef.current !== targetKey) {
    activeTargetRef.current = targetKey;
    loadGenerationRef.current += 1;
  }

  const visibleState =
    state.targetKey === targetKey
      ? state
      : {
          targetKey,
          schema: null,
          loading: true,
          schemaError: null,
        };

  const setSchema = useCallback<
    Dispatch<SetStateAction<CollectionSchema | null>>
  >(
    (nextValue) => {
      const requestTarget = targetKey;
      setState((current) => {
        if (activeTargetRef.current !== requestTarget) return current;
        const currentSchema =
          current.targetKey === requestTarget ? current.schema : null;
        const schema =
          typeof nextValue === "function"
            ? nextValue(currentSchema)
            : nextValue;
        return {
          targetKey: requestTarget,
          schema,
          loading: false,
          schemaError: null,
        };
      });
    },
    [targetKey],
  );

  const reload = useCallback(
    async (options?: { background?: boolean }) => {
      const background = Boolean(options?.background);
      const requestTarget = targetKey;
      const requestGeneration = ++loadGenerationRef.current;
      setState((current) => ({
        targetKey: requestTarget,
        schema: current.targetKey === requestTarget ? current.schema : null,
        loading:
          background && current.targetKey === requestTarget
            ? current.loading
            : true,
        schemaError: null,
      }));
      try {
        const nextSchema = await getCollectionSchema({
          spacePath,
          collectionPath,
        });
        if (
          activeTargetRef.current === requestTarget &&
          loadGenerationRef.current === requestGeneration
        ) {
          setState({
            targetKey: requestTarget,
            schema: normalizeSchema(nextSchema),
            loading: false,
            schemaError: null,
          });
        }
      } catch (error) {
        console.error("Failed to load collection:", error);
        if (
          activeTargetRef.current === requestTarget &&
          loadGenerationRef.current === requestGeneration
        ) {
          setState((current) => ({
            targetKey: requestTarget,
            schema: current.targetKey === requestTarget ? current.schema : null,
            loading: false,
            schemaError: String(error),
          }));
        }
      }
    },
    [collectionPath, spacePath, targetKey],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    schema: visibleState.schema,
    setSchema,
    loading: visibleState.loading,
    schemaError: visibleState.schemaError,
    refreshSchema: useCallback(() => reload({ background: true }), [reload]),
  };
}
