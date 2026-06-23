import { Plate, usePlateEditor } from "platejs/react";

import { Editor, EditorContainer } from "@/components/ui/editor";
import { FixedToolbar } from "@/components/ui/fixed-toolbar";
import { FixedToolbarButtons } from "@/components/ui/fixed-toolbar-buttons";
import { Skeleton } from "@/components/ui/skeleton";
import type { Entry, EntryMeta } from "@/features/entry";
import { cn } from "@/shared/lib/utils";
import { detailPageBodyClassName } from "@/shared/ui/page-layout";

import { usePlateDocumentSession } from "../hooks/use-plate-document-session";
import { EditorMediaAdapterProvider } from "../ui/editor-media-adapter-provider";
import { TocSidebar } from "../ui/toc-sidebar";
import { EditorKit } from "./editor-kit";
import * as m from "@/paraglide/messages.js";

const ENABLE_FIXED_FORMATTING_TOOLBAR = false;

interface PlateDocumentEditorProps {
  bodyOnly: true;
  pageScroll?: boolean;
  documentPath?: string | null;
  documentSpaceId?: string | null;
  spacePath?: string | null;
  projectPath?: string | null;
  bodyOnlyMeta?: EntryMeta | null;
  initialEntry?: Entry | null;
  initialEntrySpacePath?: string | null;
  onDocumentPathChange?: (path: string) => void;
}

export function PlateDocumentEditor({
  bodyOnly,
  pageScroll = false,
  documentPath = null,
  documentSpaceId = null,
  spacePath: spacePathProp = null,
  projectPath: projectPathProp = null,
  bodyOnlyMeta = null,
  initialEntry = null,
  initialEntrySpacePath = null,
  onDocumentPathChange,
}: PlateDocumentEditorProps) {
  const editor = usePlateEditor({
    plugins: EditorKit,
  });
  const usePageScroll = bodyOnly && pageScroll;
  const {
    currentDocument,
    currentDocumentSpaceId,
    deserializeToolbarMarkdown,
    documentLoading,
    handleChange,
    projectPath,
    spacePath,
  } = usePlateDocumentSession({
    bodyOnly,
    bodyOnlyMeta,
    documentPath,
    documentSpaceId,
    editor,
    initialEntry,
    initialEntrySpacePath,
    onDocumentPathChange,
    projectPath: projectPathProp,
    spacePath: spacePathProp,
  });

  return (
    <EditorMediaAdapterProvider
      documentPath={currentDocument}
      projectPath={projectPath ?? null}
      spaceId={currentDocumentSpaceId}
      spacePath={spacePath || null}
    >
      <Plate editor={editor} onChange={handleChange}>
        <div
          className={cn(
            "flex w-full flex-col",
            usePageScroll ? "min-h-0" : "h-full",
          )}
        >
          {ENABLE_FIXED_FORMATTING_TOOLBAR ? (
            <FixedToolbar>
              <FixedToolbarButtons
                deserializeMarkdown={deserializeToolbarMarkdown}
              />
            </FixedToolbar>
          ) : null}

          <div
            className={cn(
              "relative",
              usePageScroll ? "overflow-visible" : "flex-1 overflow-hidden",
            )}
          >
            <TocSidebar />
            {documentLoading ? (
              <EditorBodyLoadingState pageScroll={usePageScroll} />
            ) : null}
            <EditorContainer
              className={cn(
                usePageScroll
                  ? "h-auto overflow-visible overflow-y-visible"
                  : "h-full",
                documentLoading && "hidden",
              )}
            >
              <Editor
                variant={usePageScroll ? "none" : "default"}
                className={cn(usePageScroll && detailPageBodyClassName)}
                placeholder={m.editor_placeholder_body()}
              />
            </EditorContainer>
          </div>
        </div>
      </Plate>
    </EditorMediaAdapterProvider>
  );
}

function EditorBodyLoadingState({ pageScroll }: { pageScroll: boolean }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-5xl flex-col gap-3 px-6 py-8",
        !pageScroll && "h-full",
      )}
    >
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-4/5" />
      <Skeleton className="mt-4 h-40 w-full" />
    </div>
  );
}
