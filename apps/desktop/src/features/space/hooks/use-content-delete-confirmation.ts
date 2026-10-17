import { useCallback, useRef, useState } from "react";
import type {
  ContentBacklink,
  ContentDeleteConfirmation,
  DeletableContentObject,
  PageFolderContents,
} from "@/features/content-actions";
import { getPageDetailState } from "@/features/page/page-api";
import {
  getTreePageBacklinks,
  type BacklinkInfo,
} from "../api/content-tree-actions";
import { useSpaceStore } from "../model";

/** What a delete request deletes and where it lives. */
export interface ContentDeleteSubject<T> {
  object: DeletableContentObject;
  name: string;
  spacePath: string;
  path: string;
  projectPath: string | null;
  /** Handed back to the confirm of the dialog. */
  value: T;
}

function backlinkLabel(backlink: BacklinkInfo): string {
  if (!backlink.sourceSpaceId) return backlink.sourcePath;
  const { rootSpaces, spaces } = useSpaceStore.getState();
  const sourceSpace = [...rootSpaces, ...spaces].find(
    (item) => item.id === backlink.sourceSpaceId,
  );
  return sourceSpace
    ? `${sourceSpace.name} · ${backlink.sourcePath}`
    : backlink.sourcePath;
}

async function readBacklinks(
  subject: ContentDeleteSubject<unknown>,
): Promise<ContentBacklink[]> {
  try {
    const backlinks = await getTreePageBacklinks({
      spacePath: subject.spacePath,
      targetPath: subject.path,
      projectPath: subject.projectPath,
    });
    return backlinks.map((backlink) => ({
      key: `${backlink.sourceSpaceId ?? "root"}:${backlink.sourcePath}`,
      label: backlinkLabel(backlink),
    }));
  } catch {
    return [];
  }
}

/** A folder Page's contents decide whether the dialog names nested content. */
async function readFolderContents(
  subject: ContentDeleteSubject<unknown>,
): Promise<PageFolderContents | null> {
  const { object } = subject;
  if (!("form" in object) || object.form !== "folder") return null;
  if (object.contents) return object.contents;
  try {
    const detail = await getPageDetailState({
      spacePath: subject.spacePath,
      path: subject.path,
    });
    return {
      subpageCount: detail.subpageCount,
      otherFileCount: detail.otherFileCount,
    };
  } catch {
    return null;
  }
}

/**
 * The state of the content delete dialog of one surface. A request reads the
 * Pages that link to the object and what a folder Page holds, then opens the
 * confirmation; a newer request or a cancel drops an unfinished one.
 */
export function useContentDeleteConfirmation<T>() {
  const [confirmation, setConfirmation] =
    useState<ContentDeleteConfirmation<T> | null>(null);
  const requestRef = useRef(0);

  const requestDelete = useCallback(
    async (subject: ContentDeleteSubject<T>) => {
      const request = ++requestRef.current;
      const [backlinks, contents] = await Promise.all([
        readBacklinks(subject),
        readFolderContents(subject),
      ]);
      if (request !== requestRef.current) return;
      setConfirmation({
        object:
          contents && "form" in subject.object
            ? { ...subject.object, contents }
            : subject.object,
        name: subject.name,
        backlinks,
        value: subject.value,
      });
    },
    [],
  );

  const cancelDelete = useCallback(() => {
    requestRef.current += 1;
    setConfirmation(null);
  }, []);

  return { confirmation, requestDelete, cancelDelete };
}
