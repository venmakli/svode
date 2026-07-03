import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useSpace } from "@/features/space";
import { getCollectionSchema, listCollectionOptions } from "../api/schema-api";
import { relationScopesEqual } from "../lib/relation";
import {
  diagnoseTwoWayRelation,
  repairTwoWayRelation,
} from "../api/relation-api";
import { propertyErrorMessage } from "../lib/error-message";
import type {
  ColumnPatch,
  CollectionSchema,
  Column,
  RelationScope,
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
  const [collections, setCollections] = useState<RelationCollectionOption[]>(
    [],
  );
  const [reverseName, setReverseName] = useState(column.twoWay ?? "");
  const [diagnostics, setDiagnostics] =
    useState<RelationTwoWayDiagnostics | null>(null);
  const [diagnosticsLoading, setDiagnosticsLoading] = useState(false);
  const [selectedReverse, setSelectedReverse] = useState("");
  const [repairing, setRepairing] = useState<string | null>(null);
  const { activeRootPath, spaces } = useSpace((state) => ({
    activeRootPath: state.activeRootPath,
    spaces: state.spaces,
  }));

  useEffect(() => {
    setReverseName(column.twoWay ?? "");
  }, [column.twoWay]);

  useEffect(() => {
    let cancelled = false;
    void loadRelationCollectionOptions({
      spacePath,
      projectPath,
      activeRootPath,
      spaces,
    })
      .then((items) => {
        if (!cancelled) setCollections(items);
      })
      .catch(() => {
        if (!cancelled) setCollections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRootPath, projectPath, spacePath, spaces]);

  const relation = column.relation || ".";
  const relationScope = column.relationScope ?? null;
  const relationOptionValue = relationOptionKey(relation, relationScope);
  const options = useMemo(() => {
    const collectionOptions = collections.map((item) => ({
      value: relationOptionKey(item.path, item.relationScope),
      label: item.title || item.path,
      description: `${item.scopeLabel} - ${item.path}`,
    }));
    return collectionOptions.some((item) => item.value === relationOptionValue)
      ? collectionOptions
      : [
          {
            value: relationOptionValue,
            label: collectionLabelForPath(collections, relation, relationScope),
            description: `${scopeLabelForRelationScope(relationScope, spaces)} - ${relation}`,
          },
          ...collectionOptions,
        ];
  }, [collections, relation, relationOptionValue, relationScope, spaces]);
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
          projectPath,
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
    [collectionPath, column.name, projectPath, spacePath, twoWay],
  );

  useEffect(() => {
    let cancelled = false;
    void loadDiagnostics(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadDiagnostics, column.relation, column.relationScope, column.twoWay]);

  const patchRelation = useCallback(
    (patch: ColumnPatch) => {
      void Promise.resolve(onPatchColumn(patch)).catch((error) => {
        console.error(error);
        toast.error(propertyErrorMessage(error));
      });
    },
    [onPatchColumn],
  );

  const patchRelationSelection = useCallback(
    (value: string) => {
      const next = parseRelationOptionKey(value);
      patchRelation({
        relation: next.relation,
        relationScope: next.relationScope,
      });
    },
    [patchRelation],
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
    relation: relationOptionValue,
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
    patchRelationSelection,
    runRepair,
  };
}

interface RelationCollectionOption {
  path: string;
  title: string;
  relationScope: RelationScope | null;
  scopeLabel: string;
}

interface RelationOptionKey {
  relation: string;
  relationScope: RelationScope | null;
}

function relationOptionKey(
  relation: string,
  relationScope: RelationScope | null,
) {
  return JSON.stringify({ relation, relationScope });
}

function parseRelationOptionKey(value: string): RelationOptionKey {
  try {
    const parsed = JSON.parse(value) as Partial<RelationOptionKey>;
    if (typeof parsed.relation === "string") {
      return {
        relation: parsed.relation || ".",
        relationScope: parsed.relationScope ?? null,
      };
    }
  } catch {
    // Legacy select values were raw collection paths.
  }
  return { relation: value || ".", relationScope: null };
}

async function loadRelationCollectionOptions({
  spacePath,
  projectPath,
  activeRootPath,
  spaces,
}: {
  spacePath: string;
  projectPath?: string | null;
  activeRootPath?: string | null;
  spaces: Array<{ id: string; name: string; path: string; status: string }>;
}): Promise<RelationCollectionOption[]> {
  const rootPath = projectPath || activeRootPath || null;
  const currentIsRoot = rootPath
    ? normalizeFsPath(spacePath) === normalizeFsPath(rootPath)
    : false;
  const current = await collectionOptionsForScope(
    spacePath,
    null,
    currentIsRoot
      ? String(m.property_relation_scope_project())
      : String(m.property_relation_scope_current()),
  );

  if (!rootPath) return current;

  if (!currentIsRoot) {
    const root = await collectionOptionsForScope(
      rootPath,
      "root",
      String(m.property_relation_scope_project()),
    );
    return [...current, ...root];
  }

  const readySpaces = spaces.filter((space) => space.status === "ready");
  const childCollections = await Promise.all(
    readySpaces.map((space) =>
      collectionOptionsForScope(
        space.path,
        { type: "space", id: space.id },
        space.name || space.id,
      ),
    ),
  );
  return [...current, ...childCollections.flat()];
}

async function collectionOptionsForScope(
  spacePath: string,
  relationScope: RelationScope | null,
  scopeLabel: string,
): Promise<RelationCollectionOption[]> {
  const items = await listCollectionOptions(spacePath);
  return items.map((item) => ({
    ...item,
    relationScope,
    scopeLabel,
  }));
}

function collectionLabelForPath(
  collections: RelationCollectionOption[],
  path: string,
  relationScope: RelationScope | null,
) {
  return (
    collections.find(
      (item) =>
        item.path === path &&
        relationScopesEqual(item.relationScope, relationScope),
    )?.title || path
  );
}

function scopeLabelForRelationScope(
  relationScope: RelationScope | null,
  spaces: Array<{ id: string; name: string }>,
) {
  if (!relationScope) return String(m.property_relation_scope_current());
  if (relationScope === "root")
    return String(m.property_relation_scope_project());
  return (
    spaces.find((space) => space.id === relationScope.id)?.name ||
    relationScope.id
  );
}

function normalizeFsPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/g, "");
}
