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
  previousCollectionPath = null,
}: {
  spacePath: string;
  collectionPath: string;
  previousCollectionPath?: string | null;
}) {
  const targetKey = `${spacePath}\u0000${collectionPath}`;
  const previousTargetKey = previousCollectionPath
    ? `${spacePath}\u0000${previousCollectionPath}`
    : null;
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

  const adoptsPreviousTarget =
    previousTargetKey !== null && state.targetKey === previousTargetKey;
  const visibleState =
    state.targetKey === targetKey
      ? state
      : adoptsPreviousTarget
        ? { ...state, targetKey, loading: false, schemaError: null }
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
          current.targetKey === requestTarget ||
          (previousTargetKey !== null &&
            current.targetKey === previousTargetKey)
            ? current.schema
            : null;
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
    [previousTargetKey, targetKey],
  );

  const reload = useCallback(
    async (options?: { background?: boolean }) => {
      const background = Boolean(options?.background);
      const requestTarget = targetKey;
      const requestGeneration = ++loadGenerationRef.current;
      setState((current) => {
        const retargeting =
          previousTargetKey !== null && current.targetKey === previousTargetKey;
        return {
          targetKey: requestTarget,
          schema:
            current.targetKey === requestTarget || retargeting
              ? current.schema
              : null,
          loading:
            (background && current.targetKey === requestTarget) || retargeting
              ? current.loading
              : true,
          schemaError: null,
        };
      });
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
    [collectionPath, previousTargetKey, spacePath, targetKey],
  );

  useEffect(() => {
    void reload({ background: previousTargetKey !== null });
  }, [previousTargetKey, reload]);

  return {
    schema: visibleState.schema,
    setSchema,
    loading: visibleState.loading,
    schemaError: visibleState.schemaError,
    refreshSchema: useCallback(() => reload({ background: true }), [reload]),
  };
}
