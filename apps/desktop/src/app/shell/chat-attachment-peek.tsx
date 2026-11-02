import { lazy, Suspense, useCallback, useState, type ReactNode } from "react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useOpenArtifact,
  type ArtifactRegistryKind,
} from "@/features/artifact";
import {
  ChatAttachmentOpenerContext,
  ChatHeldMediaOpenerContext,
  chatMediaFile,
  locateChatAttachment,
  type ChatAttachment,
  type ChatAttachmentLocation,
} from "@/features/agent-sessions";
import { ChangesControl, fileChangesTarget } from "@/features/changes";
import { htmlDocumentApp, localHtmlDocumentFile } from "@/features/document";
import type { LocalDocumentFile } from "@/features/document/app-shell";
import { usePeekNavigation } from "@/features/scope-surfaces";
import type { HeldMedia, LocalMediaFile } from "@/features/media/app-shell";
import { useSpace } from "@/features/space";
import { openPath } from "@/platform/native/shell";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import { chatAttachmentRoute, htmlRoute } from "./chat-attachment-route";
import { CompactScopePeek } from "./compact-scope-peek";

const DocumentSurface = lazy(async () => ({
  default: (await import("@/features/document/app-shell")).DocumentSurface,
}));
const MediaSurface = lazy(async () => ({
  default: (await import("@/features/media/app-shell")).MediaSurface,
}));

type AttachmentPeekTarget =
  | {
      kind: ArtifactRegistryKind;
      attachment: ChatAttachment;
      location: ChatAttachmentLocation;
      /** Media and documents name the project root without a Space id. */
      registeredSpaceId: string | null;
      /** The owner peek of an App opens on that App. */
      surfaceId?: "app";
    }
  /** A media file outside the project, only to view it (DF-233 R2). */
  | { kind: "local-media"; attachment: ChatAttachment; file: LocalMediaFile }
  /** An HTML file outside the project, only to view it (Stage 11 `06` H1). */
  | {
      kind: "local-document";
      attachment: ChatAttachment;
      file: LocalDocumentFile;
    }
  /** Media of the chat without a file, or an image by its address (R2). */
  | { kind: "held-media"; media: HeldMedia };

/**
 * Opens the attachment badges of the chat by `chatAttachmentRoute`: a peek
 * over the chat — over the session peek as its child — or the system app.
 * Media the chat holds without a file opens in the same peek too.
 */
export function ChatAttachmentPeekProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [target, setTarget] = useState<AttachmentPeekTarget | null>(null);
  const rootSpaces = useSpace((state) => state.rootSpaces);
  const spaces = useSpace((state) => state.spaces);
  const activeRootId = useSpace((state) => state.activeRootId);

  const projectPath = rootSpaces.find(
    (space) => space.id === activeRootId,
  )?.path;
  const open = useCallback(
    async (attachment: ChatAttachment) => {
      const location = locateChatAttachment(attachment.path, [
        ...rootSpaces,
        ...spaces,
      ]);
      const found = chatAttachmentRoute(attachment.path, location);
      const route =
        found.kind === "html"
          ? htmlRoute(
              found.location,
              await htmlDocumentApp({
                projectPath: projectPath ?? found.location.spacePath,
                spaceId:
                  found.location.spaceId === activeRootId
                    ? null
                    : found.location.spaceId,
                path: found.location.path,
              }).catch(() => null),
            )
          : found;
      switch (route.kind) {
        case "system":
          void openPath(attachment.path);
          return;
        case "local-media":
          setTarget({
            kind: "local-media",
            attachment,
            file: chatMediaFile(attachment.path),
          });
          return;
        case "local-document":
          setTarget({
            kind: "local-document",
            attachment,
            file: localHtmlDocumentFile(attachment.path),
          });
          return;
        default:
          setTarget({
            kind: route.kind,
            attachment,
            location: route.location,
            surfaceId: route.surfaceId,
            registeredSpaceId:
              route.location.spaceId === activeRootId
                ? null
                : route.location.spaceId,
          });
      }
    },
    [activeRootId, projectPath, rootSpaces, spaces],
  );

  const openHeld = useCallback(
    (media: HeldMedia) => setTarget({ kind: "held-media", media }),
    [],
  );

  return (
    <ChatAttachmentOpenerContext.Provider
      value={(attachment) => void open(attachment)}
    >
      <ChatHeldMediaOpenerContext.Provider value={openHeld}>
        {children}
        <ChatAttachmentPeek
          target={target}
          projectPath={projectPath}
          onClose={() => setTarget(null)}
        />
      </ChatHeldMediaOpenerContext.Provider>
    </ChatAttachmentOpenerContext.Provider>
  );
}

function ChatAttachmentPeek({
  target: requested,
  projectPath,
  onClose,
}: {
  target: AttachmentPeekTarget | null;
  projectPath: string | undefined;
  onClose: () => void;
}) {
  const navigation = usePeekNavigation(requested, (target) =>
    target.kind === "held-media"
      ? `held\0${target.media.key}`
      : target.attachment.path,
  );
  const { target, leave } = navigation;
  const openArtifact = useOpenArtifact();
  const close = () => {
    navigation.dismiss();
    onClose();
  };
  usePeekStackEntry(Boolean(target), () => void leave(() => close(), "close"));
  const project =
    projectPath ??
    (target && "location" in target ? target.location.spacePath : "");

  return (
    <Sheet
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) void leave(() => close(), "close");
      }}
    >
      <SheetContent
        side="right"
        showCloseButton={false}
        overlayClassName="bg-black/25 backdrop-blur-none supports-backdrop-filter:backdrop-blur-none"
        className="gap-0 p-0 pt-2 pb-6 data-[side=right]:sm:max-w-none"
        style={{ width: "min(1120px, max(720px, 66vw), 94vw)" }}
      >
        <SheetTitle className="sr-only">
          {(target?.kind === "held-media"
            ? target.media.name
            : target?.attachment.name) ?? ""}
        </SheetTitle>
        {target?.kind === "page" ? (
          <CompactScopePeek
            key={navigation.sessionKey}
            path={target.location.path}
            surfaceId={target.surfaceId}
            spaceId={target.location.spaceId}
            spacePath={target.location.spacePath}
            projectPath={project}
            sessionKey={navigation.sessionKey}
            fallbackTitle={target.attachment.name}
            registerNavigationGuard={navigation.registerNavigationGuard}
            dismiss={close}
            onExpand={(openFull) =>
              void leave(async () => {
                if (await openFull()) close();
              }, "expand")
            }
            onClose={() => void leave(() => close(), "close")}
          />
        ) : target?.kind === "local-media" ? (
          <Suspense fallback={<Skeleton className="m-6 h-48" />}>
            <MediaSurface file={target.file} onClose={close} />
          </Suspense>
        ) : target?.kind === "local-document" ? (
          <Suspense fallback={<Skeleton className="m-6 h-48" />}>
            <DocumentSurface file={target.file} onClose={close} />
          </Suspense>
        ) : target?.kind === "held-media" ? (
          <Suspense fallback={<Skeleton className="m-6 h-48" />}>
            <MediaSurface held={target.media} onClose={close} />
          </Suspense>
        ) : target ? (
          <Suspense fallback={<Skeleton className="m-6 h-48" />}>
            {(() => {
              const Surface =
                target.kind === "document" ? DocumentSurface : MediaSurface;
              return (
                <Surface
                  path={target.location.path}
                  projectPath={project}
                  spaceId={target.registeredSpaceId}
                  spacePath={target.location.spacePath}
                  changes={
                    <ChangesControl
                      origin="peek"
                      target={fileChangesTarget({
                        spacePath: target.location.spacePath,
                        projectPath: project,
                        path: target.location.path,
                      })}
                    />
                  }
                  onClose={close}
                  onOpenFullPage={() => {
                    close();
                    openArtifact({
                      path: target.location.path,
                      sourceShape: "file",
                      spaceId: target.registeredSpaceId,
                    });
                  }}
                />
              );
            })()}
          </Suspense>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
