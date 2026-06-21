import { FilePlus } from "lucide-react";
import * as m from "@/paraglide/messages.js";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { useRootDocumentActions } from "../hooks/use-root-document-actions";

/**
 * Shown when a project has no documents and no children.
 */
export function EmptyProjectState() {
  const { activeRootPath, handleNewPage } = useRootDocumentActions();

  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FilePlus />
        </EmptyMedia>
        <EmptyTitle>{m.project_empty_title()}</EmptyTitle>
        <EmptyDescription>{m.project_empty_description()}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={handleNewPage} disabled={!activeRootPath}>
          <FilePlus data-icon="inline-start" />
          {m.project_empty_create_page()}
        </Button>
      </EmptyContent>
    </Empty>
  );
}
