import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createEntry as createEntryApi,
  readEntry as readEntryApi,
  renameEntry as renameEntryApi,
} from "@/features/entry/entry-api";
import {
  isEntryTreeMetaField,
  useEntryFieldSave,
} from "@/features/entry/field-save";
import {
  propertyFieldSavePolicy,
  type Entry,
  type EntryCover,
} from "@/features/entry";
import type {
  CollectionSchema,
  EntrySchemaResult,
} from "@/features/properties";
import { normalizeSchema } from "@/features/properties";
import { useSpaceTreeSync } from "@/features/space";
import * as m from "@/paraglide/messages.js";
import { getCollectionSchema, updateCollectionDocumentLabel } from "../api";
import { humanize } from "../lib/utils";

export function useCollectionSchemaState({
  spacePath,
  projectPath,
  collectionPath,
  readmePath,
  spaceId,
  hasReadme,
  openDocument,
}: {
  spacePath: string;
  projectPath?: string | null;
  collectionPath: string;
  readmePath: string;
  spaceId: string;
  hasReadme: boolean;
  openDocument: (path: string, spaceId: string) => void;
}) {
  const {
    reloadTreeParent,
    reloadTreePathParent,
    patchEntryTreeMeta,
  } = useSpaceTreeSync();
  const [schema, setSchema] = useState<CollectionSchema | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [parentSchema, setParentSchema] = useState<EntrySchemaResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [documentLabel, setDocumentLabel] = useState("");

  const applyReadmeEntryUpdate = useCallback(
    (entryPath: string, update: (entry: Entry) => Entry) => {
      setEntry((current) =>
        current && current.path === entryPath ? update(current) : current,
      );
    },
    [],
  );
  const updateReadmeField = useEntryFieldSave({
    spacePath,
    projectPath,
    applyEntryUpdate: applyReadmeEntryUpdate,
    onSaved: (updated, context) => {
      if (isEntryTreeMetaField(context.field)) {
        patchEntryTreeMeta(
          spaceId,
          readmePath,
          updated.meta.title,
          updated.meta.icon,
          updated.meta.description ?? null,
        );
      }
    },
  });

  const reload = useCallback(async (options?: { background?: boolean }) => {
    const background = Boolean(options?.background);
    if (!background) setLoading(true);
    setSchemaError(null);
    try {
      const nextSchema = await getCollectionSchema({
        spacePath,
        collectionPath,
      });
      setSchema(normalizeSchema(nextSchema));
      if (hasReadme) {
        const nextEntry = await readEntryApi({ spacePath, path: readmePath });
        setEntry(nextEntry);
      } else {
        setEntry(null);
      }
      let parent: EntrySchemaResult | null = null;
      const parentCollectionPath = collectionPath.includes("/")
        ? collectionPath.slice(0, collectionPath.lastIndexOf("/"))
        : "";
      if (hasReadme) {
        parent = await getCollectionSchema({
          spacePath,
          collectionPath: parentCollectionPath,
        })
          .then((parentCollectionSchema) => ({
            schema: parentCollectionSchema,
            collectionRootPath: parentCollectionPath,
          }))
          .catch(() => null);
      }
      setParentSchema(parent);
    } catch (error) {
      console.error("Failed to load collection:", error);
      setSchemaError(String(error));
    } finally {
      if (!background) setLoading(false);
    }
  }, [collectionPath, hasReadme, readmePath, spacePath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const refreshSchema = useCallback(
    () => reload({ background: true }),
    [reload],
  );

  useEffect(() => {
    setDocumentLabel(schema?.document?.label ?? m.collection_document_tab());
  }, [schema]);

  const propertiesSchema = useMemo(
    () =>
      parentSchema && parentSchema.collectionRootPath !== collectionPath
        ? { ...parentSchema, schema: normalizeSchema(parentSchema.schema) }
        : null,
    [collectionPath, parentSchema],
  );

  async function createReadmeForIdentity() {
    if (hasReadme) return entry;
    const created = await createEntryApi({
      spacePath,
      parentPath: collectionPath,
      title: humanize(collectionPath),
      projectPath: projectPath ?? null,
    });
    let nextEntry = created;
    if (created.path.toLowerCase() !== readmePath.toLowerCase()) {
      await renameEntryApi({
        spacePath,
        from: created.path,
        to: readmePath,
        projectPath: projectPath ?? null,
      });
      nextEntry = await readEntryApi({ spacePath, path: readmePath });
    }
    await reloadTreePathParent(spaceId, readmePath);
    await reloadTreeParent(spaceId, collectionPath);
    openDocument(readmePath, spaceId);
    setEntry(nextEntry);
    return nextEntry;
  }

  async function updateIdentity(
    field: "title" | "icon" | "description",
    value: unknown,
  ) {
    if (!hasReadme) {
      const created = await createReadmeForIdentity();
      if (!created) return;
      await updateReadmeField(created, field, value, { flush: true });
      return;
    }
    if (!entry) return;
    await updateReadmeField(entry, field, value);
  }

  async function updateCover(nextCover: EntryCover | null) {
    if (!hasReadme) return;
    if (!entry) return;
    await updateReadmeField(entry, "cover", nextCover);
  }

  async function updateReadmeProperty(field: string, value: unknown) {
    if (!entry || !propertiesSchema) return;
    const column = propertiesSchema.schema.columns.find(
      (item) => item.name === field,
    );
    await updateReadmeField(entry, field, value, {
      policy: column ? propertyFieldSavePolicy(column) : undefined,
    });
  }

  async function saveDocumentLabel() {
    const label = documentLabel.trim() || null;
    const next = await updateCollectionDocumentLabel({
      spacePath,
      collectionPath,
      label,
      projectPath,
    });
    setSchema(normalizeSchema(next));
  }

  return {
    schema,
    setSchema,
    entry,
    setEntry,
    propertiesSchema,
    loading,
    schemaError,
    documentLabel,
    setDocumentLabel,
    refreshSchema,
    updateReadmeProperty,
    createReadmeForIdentity,
    updateIdentity,
    updateCover,
    saveDocumentLabel,
  };
}
