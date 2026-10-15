import { lazy, Suspense } from "react";
import { AlertTriangle, FileText } from "lucide-react";

import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { CollectionDetailContent } from "@/features/collection/app-shell";
import * as m from "@/paraglide/messages.js";
import {
  MarkdownReader,
  type MarkdownReaderPolicy,
} from "@/shared/ui/markdown-reader";

import {
  agentContextArtifactExternalOpenTarget,
  agentContextSkillFileSource,
} from "../api/agent-context-api";
import { useSkillMarkdownFile } from "../hooks/use-skill-files";
import type { AgentContextItem, AgentContextSkillFile } from "../model/types";
import { AgentContextArtifactOpenWith } from "./artifact-open-with";
import { AgentContextContentTruncatedNotice } from "./content-truncated-notice";

const DocumentSurface = lazy(async () => ({
  default: (await import("@/features/document/app-shell")).DocumentSurface,
}));
const MediaSurface = lazy(async () => ({
  default: (await import("@/features/media/app-shell")).MediaSurface,
}));

const fileReaderPolicy: MarkdownReaderPolicy = {};

/**
 * The peek of a file of a skill, only to view it, wherever it lies: Markdown
 * in the reader, documents and media in their own viewers. "Open with" opens
 * the file inside the skill owner's root.
 */
export function createSkillFileDetailContent({
  file,
  item,
  onClose,
}: {
  file: AgentContextSkillFile;
  item: AgentContextItem;
  onClose(): void;
}): CollectionDetailContent {
  const openTarget = {
    canonicalArtifactPath: file.canonicalPath,
    ownerRoot: item.ownerPath,
  };
  const description = m.agent_context_skill_file_description({
    skill: item.name,
  });
  if (file.kind === "markdown") {
    return {
      content: <SkillMarkdownFile itemId={item.id} path={file.path} />,
      description,
      identity: { icon: <FileText />, name: file.name },
      openWith: <AgentContextArtifactOpenWith {...openTarget} />,
      title: file.name,
    };
  }
  const externalOpen = agentContextArtifactExternalOpenTarget(openTarget);
  const source = agentContextSkillFileSource(item.id, file.path);
  return {
    content: (
      <Suspense fallback={<Skeleton className="m-6 h-48" />}>
        {file.kind === "document" ? (
          <DocumentSurface
            file={{
              externalOpen,
              inspect: source.inspectDocument,
              path: file.canonicalPath,
              read: source.readDocument,
            }}
            onClose={onClose}
          />
        ) : (
          <MediaSurface
            file={{
              createSource: source.createMediaSource,
              externalOpen,
              path: file.canonicalPath,
            }}
            onClose={onClose}
          />
        )}
      </Suspense>
    ),
    description,
    layout: "surface",
    title: file.name,
  };
}

function SkillMarkdownFile({ itemId, path }: { itemId: string; path: string }) {
  const { retry, state } = useSkillMarkdownFile(itemId, path);
  if (state.phase === "loading") {
    return (
      <div
        className="flex flex-col gap-3"
        data-agent-context-skill-file="loading"
      >
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (state.phase === "error") {
    return (
      <Alert variant="destructive" data-agent-context-skill-file="error">
        <AlertTriangle />
        <AlertTitle>{m.agent_context_skill_file_error_title()}</AlertTitle>
        <AlertDescription>{state.message}</AlertDescription>
        <AlertAction>
          <Button size="sm" variant="outline" onClick={retry}>
            {m.attachments_retry()}
          </Button>
        </AlertAction>
      </Alert>
    );
  }
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      data-agent-context-skill-file="ready"
    >
      <AgentContextContentTruncatedNotice truncated={state.truncated} />
      <MarkdownReader content={state.markdown} policy={fileReaderPolicy} />
    </div>
  );
}
