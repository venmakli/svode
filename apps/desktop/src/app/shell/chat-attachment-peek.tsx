import {
  lazy,
  Suspense,
  useCallback,
  useState,
  type ReactNode,
} from "react";
import { Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useOpenArtifact } from "@/features/artifact";
import {
  ChatAttachmentOpenerContext,
  chatAttachmentKind,
  locateChatAttachment,
  type ChatAttachment,
  type ChatAttachmentLocation,
} from "@/features/agent-sessions";
import { usePeekNavigation } from "@/features/scope-surfaces";
import { useSpace } from "@/features/space";
import { openPath } from "@/platform/native/shell";
import {
  AUDIO_EXTS,
  DOCUMENT_EXTS,
  IMAGE_EXTS,
  VIDEO_EXTS,
} from "@/platform/upload/media-types";
import { usePeekStackEntry } from "@/shared/hooks/use-peek-stack-entry";
import { CompactScopePeek } from "./compact-scope-peek";
import * as m from "@/paraglide/messages.js";

const DocumentSurface = lazy(async () => ({
  default: (await import("@/features/document/app-shell")).DocumentSurface,
}));
const MediaSurface = lazy(async () => ({
  default: (await import("@/features/media/app-shell")).MediaSurface,
}));

type ViewerKind = "page" | "document" | "media";

interface AttachmentPeekTarget {
  kind: ViewerKind;
  attachment: ChatAttachment;
  location: ChatAttachmentLocation;
  /** Media and documents name the project root without a Space id. */
  registeredSpaceId: string | null;
}

const MEDIA_EXTENSIONS = new Set<string>([
  ...IMAGE_EXTS,
  ...VIDEO_EXTS,
  ...AUDIO_EXTS,
]);
const DOCUMENT_EXTENSIONS = new Set<string>(DOCUMENT_EXTS);

function viewerKind(attachment: ChatAttachment): ViewerKind | null {
  if (chatAttachmentKind(attachment.path) === "page") return "page";
  const dot = attachment.path.lastIndexOf(".");
  const extension = dot >= 0 ? attachment.path.slice(dot).toLowerCase() : "";
  if (MEDIA_EXTENSIONS.has(extension)) return "media";
  if (DOCUMENT_EXTENSIONS.has(extension)) return "document";
  return null;
}

/**
 * Opens the attachment badges of the chat (Stage 10 `04`): a page or a file
 * of the project in a peek over the chat — over the session peek as its
 * child — and anything else, a file outside the project or a pasted image,
 * in its system app.
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

  const open = useCallback(
    (attachment: ChatAttachment) => {
      const location = locateChatAttachment(attachment.path, [
        ...rootSpaces,
        ...spaces,
      ]);
      const kind = viewerKind(attachment);
      if (location && kind) {
        setTarget({
          kind,
          attachment,
          location,
          registeredSpaceId:
            location.spaceId === activeRootId ? null : location.spaceId,
        });
        return;
      }
      void openPath(attachment.path);
    },
    [activeRootId, rootSpaces, spaces],
  );

  return (
    <ChatAttachmentOpenerContext.Provider value={open}>
      {children}
      <ChatAttachmentPeek
        target={target}
        projectPath={rootSpaces.find((space) => space.id === activeRootId)?.path}
        onClose={() => setTarget(null)}
      />
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
  const navigation = usePeekNavigation(
    requested,
    (target) => target.attachment.path,
  );
  const { target, leave } = navigation;
  const openArtifact = useOpenArtifact();
  const close = () => {
    navigation.dismiss();
    onClose();
  };
  usePeekStackEntry(Boolean(target), () => void leave(() => close()));
  const project = projectPath ?? target?.location.spacePath ?? "";

  return (
    <Sheet
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open) void leave(() => close());
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
          {target?.attachment.name ?? ""}
        </SheetTitle>
        {target?.kind === "page" ? (
          <CompactScopePeek
            key={navigation.sessionKey}
            path={target.location.path}
            spaceId={target.location.spaceId}
            spacePath={target.location.spacePath}
            projectPath={project}
            sessionKey={navigation.sessionKey}
            fallbackTitle={target.attachment.name}
            registerNavigationGuard={navigation.registerNavigationGuard}
            dismiss={close}
            renderActions={(openFull, owner) => (
              <PeekActions
                onExpand={
                  owner
                    ? () =>
                        void leave(async () => {
                          if (await openFull()) close();
                        })
                    : null
                }
                onClose={() => void leave(() => close())}
              />
            )}
          />
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
                  onClose={close}
                  onOpenFullPage={() => {
                    close();
                    openArtifact({
                      path: target.location.path,
                      sourceShape: "file",
                      spaceId: target.registeredSpaceId,
                    });
                  }}
                  renderToolbarActions={(actions) => (
                    <PeekActions
                      onExpand={actions.onOpenFullPage}
                      onClose={actions.onClose}
                    />
                  )}
                />
              );
            })()}
          </Suspense>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** "Full page" and close, as in the Attachments Peek. */
function PeekActions({
  onExpand,
  onClose,
}: {
  onExpand: (() => void) | null;
  onClose: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {onExpand && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-lg px-2 text-xs text-muted-foreground hover:text-foreground"
          onClick={onExpand}
        >
          <Maximize2 data-icon="inline-start" />
          {m.attachments_full_page()}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground hover:text-foreground"
        onClick={onClose}
      >
        <X />
        <span className="sr-only">{m.settings_cancel()}</span>
      </Button>
    </div>
  );
}
