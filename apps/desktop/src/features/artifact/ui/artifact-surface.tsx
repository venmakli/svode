import {
  Component,
  Suspense,
  lazy,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { FileQuestion, FileWarning } from "lucide-react";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { probeDocumentTarget } from "@/features/document";
import { probeMediaTarget } from "@/features/media";
import { probeMarkedApp } from "../api/probe-app-marker";
import { useArtifactResolution } from "../hooks/use-artifact-resolution";
import { ArtifactRegistry } from "../model/registry";
import type {
  ActiveArtifactOpenRequest,
  ArtifactOpenTarget,
} from "../model/types";
import * as m from "@/paraglide/messages.js";

interface ArtifactSurfaceProps {
  request: ActiveArtifactOpenRequest;
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
  pageSessionKey?: string;
  retainSurfaceDuringRetarget?: boolean;
}

interface ArtifactSurfaceRenderProps {
  target: ArtifactOpenTarget;
  spacePath: string;
  projectPath: string | null;
  spaceId: string;
  onOpenRepositorySettings?: (repositoryPath: string) => void;
  pageSessionKey?: string;
}

type ArtifactSurfaceComponent = ComponentType<ArtifactSurfaceRenderProps>;

async function loadPageSurface(): Promise<{
  default: ArtifactSurfaceComponent;
}> {
  const { PageScreen, PageSurfaceSessionProvider } =
    await import("@/features/page/app-shell");
  return {
    default: function PageArtifactSurface({
      target,
      spacePath,
      projectPath,
      spaceId,
      onOpenRepositorySettings,
      pageSessionKey,
    }: ArtifactSurfaceRenderProps) {
      return (
        <PageSurfaceSessionProvider
          displayName={artifactDisplayName(target.path)}
          displayPath={target.path}
          onOpenRepositorySettings={onOpenRepositorySettings}
          registerGlobalDeactivation
          spacePath={spacePath}
          targetKey={pageSessionKey ?? `${spaceId}:${target.path}`}
        >
          <PageScreen
            spacePath={spacePath}
            projectPath={projectPath}
            pagePath={target.path}
            spaceId={spaceId}
          />
        </PageSurfaceSessionProvider>
      );
    },
  };
}

const PageArtifactSurface = lazy(loadPageSurface);

async function loadDocumentSurface(): Promise<{
  default: ArtifactSurfaceComponent;
}> {
  const { DocumentSurface } = await import("@/features/document/app-shell");
  return {
    default: function DocumentArtifactSurface({
      projectPath,
      spacePath,
      target,
    }: ArtifactSurfaceRenderProps) {
      return (
        <DocumentSurface
          path={target.path}
          projectPath={projectPath ?? spacePath}
          spaceId={target.spaceId}
          spacePath={spacePath}
        />
      );
    },
  };
}

const DocumentArtifactSurface = lazy(loadDocumentSurface);

async function loadMediaSurface(): Promise<{
  default: ArtifactSurfaceComponent;
}> {
  const { MediaSurface } = await import("@/features/media/app-shell");
  return {
    default: function MediaArtifactSurface({
      projectPath,
      spacePath,
      target,
    }: ArtifactSurfaceRenderProps) {
      return (
        <MediaSurface
          path={target.path}
          projectPath={projectPath ?? spacePath}
          spaceId={target.spaceId}
          spacePath={spacePath}
        />
      );
    },
  };
}

const MediaArtifactSurface = lazy(loadMediaSurface);

function createFirstPartyArtifactRegistry(spacePath: string) {
  return new ArtifactRegistry<ArtifactSurfaceComponent>([
    {
      id: "app",
      order: 100,
      capabilities: {},
      probe: (target) => probeMarkedApp(target, spacePath),
    },
    {
      id: "document",
      order: 150,
      capabilities: { readOnly: true },
      probe: probeDocumentTarget,
      surface: DocumentArtifactSurface,
    },
    {
      id: "media",
      order: 175,
      capabilities: { readOnly: true },
      probe: probeMediaTarget,
      surface: MediaArtifactSurface,
    },
    {
      id: "page",
      order: 200,
      capabilities: { pageLifecycle: true },
      probe: (target) =>
        target.semanticHint?.kind === "page"
          ? {
              status: "match",
              identity: {
                kind: "page",
                path: target.path,
                sourceShape: target.sourceShape,
              },
            }
          : { status: "no_match" },
      surface: PageArtifactSurface,
    },
  ]);
}

export function ArtifactSurface({
  request,
  spacePath,
  projectPath,
  spaceId,
  onOpenRepositorySettings,
  pageSessionKey,
  retainSurfaceDuringRetarget = false,
}: ArtifactSurfaceProps) {
  const registry = useMemo(
    () => createFirstPartyArtifactRegistry(spacePath),
    [spacePath],
  );
  const resolution = useArtifactResolution(registry, request, {
    retainPreviousResolution: retainSurfaceDuringRetarget,
  });
  const Surface =
    resolution &&
    (resolution.status === "ready" || resolution.status === "limited")
      ? resolution.adapter.surface
      : null;

  if (!resolution) return <ArtifactLoadingState />;
  if (resolution.status === "cancelled") return <ArtifactLoadingState />;
  if (resolution.status === "error") return <ArtifactErrorState />;
  if (resolution.status === "no_match") return <ArtifactUnsupportedState />;
  if (resolution.status === "unsupported" || !Surface) {
    return <ArtifactUnsupportedState />;
  }

  return (
    <ArtifactSurfaceErrorBoundary
      resetKey={`${request.key}:${resolution.adapter.id}`}
    >
      <Suspense fallback={<ArtifactLoadingState />}>
        <Surface
          target={request.intent.target}
          spacePath={spacePath}
          projectPath={projectPath}
          spaceId={spaceId}
          onOpenRepositorySettings={onOpenRepositorySettings}
          pageSessionKey={pageSessionKey}
        />
      </Suspense>
    </ArtifactSurfaceErrorBoundary>
  );
}

function artifactDisplayName(path: string) {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.at(-1) ?? path;
  return name.toLowerCase() === "readme.md"
    ? (segments.at(-2) ?? name)
    : name.replace(/\.md$/i, "");
}

function ArtifactLoadingState() {
  return (
    <div
      className="flex min-h-full flex-col gap-4 px-8 py-12"
      aria-label={m.artifact_open_loading()}
    >
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-4 h-64 w-full" />
    </div>
  );
}

function ArtifactErrorState() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileWarning />
        </EmptyMedia>
        <EmptyTitle>{m.artifact_open_error_title()}</EmptyTitle>
        <EmptyDescription>
          {m.artifact_open_error_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function ArtifactUnsupportedState() {
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileQuestion />
        </EmptyMedia>
        <EmptyTitle>{m.artifact_open_unsupported_title()}</EmptyTitle>
        <EmptyDescription>
          {m.artifact_open_unsupported_description()}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

interface ArtifactSurfaceErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
}

interface ArtifactSurfaceErrorBoundaryState {
  hasError: boolean;
}

class ArtifactSurfaceErrorBoundary extends Component<
  ArtifactSurfaceErrorBoundaryProps,
  ArtifactSurfaceErrorBoundaryState
> {
  state: ArtifactSurfaceErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ArtifactSurfaceErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(previous: ArtifactSurfaceErrorBoundaryProps) {
    if (previous.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? <ArtifactErrorState /> : this.props.children;
  }
}
