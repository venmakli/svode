import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getCollectionSchema,
  listCollectionOptions,
} from "../api/schema-api";
import {
  diagnoseTwoWayRelation,
  repairTwoWayRelation,
} from "../api/relation-api";
import { propertyErrorMessage } from "../lib/error-message";
import type {
  ColumnPatch,
  CollectionSchema,
  Column,
  RelationRepairStrategy,
  RelationTwoWayDiagnostics,
} from "../model/types";
import * as m from "@/paraglide/messages.js";

interface UseRelationSettingsInput {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  onPatchColumn: (patch: ColumnPatch) => void | Promise<void>;
}

export function useRelationSettings({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
  onPatchColumn,
}: UseRelationSettingsInput) {
  const [collections, setCollections] = useState<
    Array<{ path: string; title: string }>
  >([]);
  const [reverseName, setReverseName] = useState(
    column.twoWay ?? "",
  );
  const [diagnostics, setDiagnostics] =
    useState<RelationTwoWayDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [selectedReverse, setSelectedReverse] = useState("");
  const [repairing, setRepairing] = useState<string | null>(null);

  useEffect(() => {
    setReverseName(column.twoWay ?? "");
  }, [column.twoWay]);

  useEffect(() => {
    let cancelled = false;
    void listCollectionOptions(spacePath)
      .then((items) => {
        if (!cancelled) setCollections(items);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spacePath]);

  const relation = column.relation || ".";
  const options = useMemo(() => {
    const collectionOptions = collections.map((item) => ({
      value: item.path,
      label: item.title || item.path,
      description: item.path,
    }));
    return collectionOptions.some((item) => item.value === relation)
      ? collectionOptions
      : [
          {
            value: relation,
            label: collectionLabelForPath(collections, relation),
            description: relation,
          },
          ...collectionOptions,
        ];
  }, [collections, relation]);
  const twoWay = Boolean(column.twoWay);

  const loadDiagnostics = useCallback(
    async (cancelled?: () => boolean) => {
      if (!twoWay) {
        setDiagnostics(null);
        setDiagnosticsLoading(false);
        return;
      }
      setDiagnosticsLoading(true);
      try {
        const next = await diagnoseTwoWayRelation({
          spacePath,
          collectionPath,
          column: column.name,
        });
        if (cancelled?.()) return;
        setDiagnostics(next);
        setSelectedReverse((current) => {
          if (current) return current;
          return next.compatibleReverseChoices[0]?.name ?? "";
        });
      } catch (error) {
        if (cancelled?.()) return;
        console.error(error);
        setDiagnostics(null);
      } finally {
        if (!cancelled?.()) setDiagnosticsLoading(false);
      }
    },
    [collectionPath, column.name, spacePath, twoWay],
  );

  useEffect(() => {
    let cancelled = false;
    void loadDiagnostics(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadDiagnostics, column.relation, column.twoWay]);

  const patchRelation = useCallback(
    (patch: ColumnPatch) => {
      void Promise.resolve(onPatchColumn(patch)).catch((error) => {
        console.error(error);
        toast.error(propertyErrorMessage(error));
      });
    },
    [onPatchColumn],
  );

  const runRepair = useCallback(
    async (strategy: RelationRepairStrategy, reverseColumn?: string | null) => {
      setRepairing(strategy);
      try {
        await repairTwoWayRelation({
          spacePath,
          projectPath,
          collectionPath,
          column: column.name,
          strategy,
          reverseColumn,
        });
        const schema = await getCollectionSchema({
          spacePath,
          collectionPath,
          projectPath,
        });
        onSchemaChange(schema);
        await loadDiagnostics();
        toast.success(m.property_relation_repair_success());
      } catch (error) {
        console.error(error);
        toast.error(propertyErrorMessage(error));
      } finally {
        setRepairing(null);
      }
    },
    [
      collectionPath,
      column.name,
      loadDiagnostics,
      onSchemaChange,
      projectPath,
      spacePath,
    ],
  );

  return {
    relation,
    options,
    twoWay,
    reverseName,
    setReverseName,
    diagnostics,
    diagnosticsLoading,
    selectedReverse,
    setSelectedReverse,
    repairing,
    patchRelation,
    runRepair,
  };
}

function collectionLabelForPath(
  collections: Array<{ path: string; title: string }>,
  path: string,
) {
  return collections.find((item) => item.path === path)?.title || path;
}
