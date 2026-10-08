import { useState, type CSSProperties, type ReactNode } from "react";
import {
  File,
  FileImage,
  FileVideo,
  FileWarning,
  FileX,
  Music,
  Play,
} from "lucide-react";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatMediaBytes, formatMediaDuration } from "@/features/media";
import { cn } from "@/shared/lib/utils";
import { openInSystem } from "../api/attachments";
import type { AgentMediaSegmentDto, AgentSessionKeyDto } from "../api/chat";
import { useAttachmentAvailable } from "../hooks/use-attachment-preview";
import { useOpenMedia } from "../hooks/use-media-opener";
import { useMediaView, type MediaView } from "../hooks/use-media-view";
import {
  agentMessageParts,
  groupMedia,
  mediaTypeLabel,
  tileLayout,
  type ChatMedia,
} from "../model/media";
import { AgentText } from "./agent-text";
import * as m from "@/paraglide/messages.js";

/** Height bound of a single uncropped tile, in px. */
const SINGLE_MAX_HEIGHT = 320;

const FOCUS_RING =
  "outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * An agent message with its media at their places in the text (`08` R2):
 * the text as markdown, the media as tiles, player rows and file cards.
 */
export function AgentMessageContent({
  session,
  itemId,
  text,
  media,
}: {
  session: AgentSessionKeyDto;
  itemId: string;
  text: string;
  media: readonly AgentMediaSegmentDto[];
}) {
  if (media.length === 0) return <AgentText text={text} />;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {agentMessageParts(itemId, text, media).map((part, index) =>
        part.type === "text" ? (
          <AgentText key={index} text={part.text} />
        ) : (
          <ChatMediaView key={index} session={session} media={part.media} />
        ),
      )}
    </div>
  );
}

/**
 * Media shown together (`08` R2, Composition): images and videos as tiles
 * in the layout by their count, audio as player rows, other files as cards
 * in rows. A click or Enter opens a media by the badge rule.
 */
export function ChatMediaView({
  session,
  media,
}: {
  session: AgentSessionKeyDto;
  media: readonly ChatMedia[];
}) {
  const { tiles, audio, files } = groupMedia(media);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-chat-media>
      {tiles.length > 0 && <MediaTiles session={session} tiles={tiles} />}
      {audio.map((entry) => (
        <AudioRow key={entry.key} session={session} media={entry} />
      ))}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((entry) => (
            <FileCard key={entry.key} session={session} media={entry} />
          ))}
        </div>
      )}
    </div>
  );
}

function MediaTiles({
  session,
  tiles,
}: {
  session: AgentSessionKeyDto;
  tiles: ChatMedia[];
}) {
  const [expanded, setExpanded] = useState(false);
  const layout = tileLayout(tiles.length, expanded);
  const shown = tiles.slice(0, layout.shown);
  if (layout.kind === "single") {
    return <MediaTile session={session} media={shown[0]} single />;
  }
  const expandedGrid = layout.kind === "grid" && layout.shown > 4;
  return (
    <div
      data-media-layout={expandedGrid ? "expanded" : layout.kind}
      className={cn(
        "grid w-full gap-1.5",
        expandedGrid ? "max-w-xl grid-cols-3" : "max-w-md grid-cols-2",
        layout.kind === "triple" && "aspect-square grid-rows-2",
      )}
    >
      {shown.map((entry, index) => {
        const more = layout.more > 0 && index === layout.shown - 1;
        return (
          <div
            key={entry.key}
            className={cn(
              "min-h-0 min-w-0",
              layout.kind === "triple"
                ? index === 0 && "row-span-2"
                : "aspect-square",
            )}
          >
            {more ? (
              <button
                type="button"
                aria-label={m.sessions_chat_media_more_label({
                  count: layout.more,
                })}
                onClick={() => setExpanded(true)}
                className={cn(
                  "flex size-full items-center justify-center rounded-lg bg-muted text-lg font-medium text-muted-foreground hover:text-foreground",
                  FOCUS_RING,
                )}
              >
                {m.sessions_chat_media_more({ count: layout.more })}
              </button>
            ) : (
              <MediaTile session={session} media={entry} single={false} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** An image or a video: uncropped alone, cropped to its cell in a layout. */
function MediaTile({
  session,
  media,
  single,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
  single: boolean;
}) {
  const { view, fail } = useMediaView(session, media);
  const open = useOpenMedia(session);
  const name = mediaName(media);
  const reserve = single ? reservedSize(view) : undefined;

  if (view.state === "loading") {
    return (
      <Skeleton
        data-media-state="loading"
        aria-label={name}
        className={cn(
          "rounded-lg",
          single ? "aspect-[4/3] w-full max-w-sm" : "size-full",
        )}
      />
    );
  }
  if (view.state !== "ready") {
    return (
      <MediaStatus
        session={session}
        media={media}
        view={view}
        className={single ? "aspect-[4/3] w-full max-w-sm" : "size-full"}
      />
    );
  }
  return (
    <button
      type="button"
      aria-label={name}
      data-media-state="ready"
      onClick={() => open(media)}
      style={reserve}
      className={cn(
        "relative block overflow-hidden rounded-lg bg-muted",
        single ? "max-w-full" : "size-full",
        FOCUS_RING,
      )}
    >
      {media.kind === "video" ? (
        <VideoFrame url={view.url} cover={!single} onError={fail} />
      ) : (
        <img
          src={view.url}
          alt={name}
          draggable={false}
          onError={fail}
          className={cn(
            "block",
            single
              ? reserve
                ? "size-full object-contain"
                : "max-h-80 max-w-full"
              : "size-full object-cover",
          )}
        />
      )}
    </button>
  );
}

/** The place of a single tile, known before the image decodes. */
function reservedSize(view: MediaView): CSSProperties | undefined {
  if (view.state !== "ready" || !view.width || !view.height) return undefined;
  return {
    aspectRatio: `${view.width} / ${view.height}`,
    width: `min(100%, ${view.width}px, ${
      (SINGLE_MAX_HEIGHT * view.width) / view.height
    }px)`,
  };
}

/** The first frame of a video, its play mark and duration. */
function VideoFrame({
  url,
  cover,
  onError,
}: {
  url: string;
  cover: boolean;
  onError: () => void;
}) {
  const [duration, setDuration] = useState<number | null>(null);
  return (
    <>
      <video
        src={url}
        preload="metadata"
        muted
        playsInline
        tabIndex={-1}
        aria-hidden
        onError={onError}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration;
          if (Number.isFinite(value)) setDuration(value);
        }}
        className={cn(
          "pointer-events-none block",
          cover ? "size-full object-cover" : "max-h-80 max-w-full",
        )}
      />
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-black/55 text-white">
          <Play className="size-5 fill-current" />
        </span>
      </span>
      {duration !== null && (
        <span className="absolute right-1.5 bottom-1.5 rounded-sm bg-black/60 px-1 text-xs text-white tabular-nums">
          {formatMediaDuration(duration)}
        </span>
      )}
    </>
  );
}

/** Audio: a player row with its name. */
function AudioRow({
  session,
  media,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
}) {
  const { view, fail } = useMediaView(session, media);
  const open = useOpenMedia(session);
  const name = mediaName(media);
  return (
    <div
      data-media-state={view.state}
      className="flex w-full max-w-md min-w-0 items-center gap-2 rounded-lg border px-2.5 py-1.5"
    >
      <Music className="size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        onClick={() => open(media)}
        className={cn(
          "min-w-0 shrink truncate rounded-sm text-left text-sm hover:underline",
          FOCUS_RING,
        )}
      >
        {name}
      </button>
      <div className="flex min-w-0 flex-1 justify-end">
        {view.state === "loading" ? (
          <Skeleton className="h-8 w-full rounded-full" />
        ) : view.state === "ready" ? (
          <audio
            src={view.url}
            controls
            preload="metadata"
            onError={fail}
            aria-label={m.media_audio_player({ filename: name })}
            className="h-8 w-full min-w-0"
          />
        ) : (
          <MediaStatus session={session} media={media} view={view} inline />
        )}
      </div>
    </div>
  );
}

/** Another file: icon, name, type and size; it opens by the badge rule. */
function FileCard({
  session,
  media,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
}) {
  if (media.path) {
    return <PathFileCard session={session} media={media} path={media.path} />;
  }
  return <FileCardView session={session} media={media} missing={false} />;
}

function PathFileCard({
  session,
  media,
  path,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
  path: string;
}) {
  const available = useAttachmentAvailable(path);
  return (
    <Hint hint={path}>
      <div className="flex min-w-0">
        <FileCardView
          session={session}
          media={media}
          missing={available === false}
        />
      </div>
    </Hint>
  );
}

function FileCardView({
  session,
  media,
  missing,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
  missing: boolean;
}) {
  const open = useOpenMedia(session);
  const name = mediaName(media);
  const details = [
    mediaTypeLabel(media),
    media.size !== null ? formatMediaBytes(media.size) : null,
  ].filter(Boolean);
  return (
    <Attachment
      size="sm"
      state={missing ? "error" : "done"}
      data-media-state={missing ? "missing" : "ready"}
      className="max-w-64"
    >
      <AttachmentMedia>{missing ? <FileX /> : <File />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        <AttachmentDescription>
          {missing
            ? m.sessions_chat_media_unavailable()
            : details.join(" · ") || m.sessions_chat_attachment_file()}
        </AttachmentDescription>
      </AttachmentContent>
      {!missing && (
        <AttachmentTrigger aria-label={name} onClick={() => open(media)} />
      )}
    </Attachment>
  );
}

/**
 * A media that is not shown: gone, too large, let go by the runtime, or
 * unreadable — with the way to its app where there is one.
 */
function MediaStatus({
  session,
  media,
  view,
  className,
  inline = false,
}: {
  session: AgentSessionKeyDto;
  media: ChatMedia;
  view: Exclude<MediaView, { state: "loading" | "ready" }>;
  className?: string;
  inline?: boolean;
}) {
  const open = useOpenMedia(session);
  const name = mediaName(media);
  const Icon =
    view.state === "missing"
      ? FileX
      : view.state === "error"
        ? FileWarning
        : media.kind === "video"
          ? FileVideo
          : FileImage;
  const text =
    view.state === "missing"
      ? m.sessions_chat_media_unavailable()
      : view.state === "too_large"
        ? m.sessions_chat_media_too_large()
        : view.state === "released"
          ? m.sessions_chat_media_released()
          : name;
  // A file too large to show opens in its app; an unreadable media too.
  const action =
    (view.state === "too_large" && media.path) ||
    (view.state === "error" && (media.path || media.data)) ? (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() =>
          media.path ? void openInSystem(media.path) : open(media)
        }
      >
        {m.sessions_chat_media_open_in_app()}
      </Button>
    ) : null;
  const body = (
    <div
      role="group"
      aria-label={view.state === "error" ? name : `${name}: ${text}`}
      data-media-state={view.state}
      tabIndex={view.state === "missing" ? 0 : undefined}
      className={cn(
        inline
          ? "flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
          : "flex flex-col items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-dashed bg-muted/40 p-3 text-center text-xs text-muted-foreground",
        FOCUS_RING,
        className,
      )}
    >
      {!inline && <Icon className="size-5 shrink-0" />}
      <span className="line-clamp-3 min-w-0 break-words">{text}</span>
      {action}
    </div>
  );
  return view.state === "missing" && media.path ? (
    <Hint hint={media.path}>{body}</Hint>
  ) : (
    body
  );
}

function mediaName(media: ChatMedia): string {
  if (media.name) return media.name;
  switch (media.kind) {
    case "image":
      return m.sessions_chat_attachment_image();
    case "video":
      return m.sessions_chat_media_video();
    case "audio":
      return m.sessions_chat_media_audio();
    case "file":
      return m.sessions_chat_attachment_file();
  }
}

function Hint({ hint, children }: { hint: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="max-w-sm break-all">{hint}</TooltipContent>
    </Tooltip>
  );
}
