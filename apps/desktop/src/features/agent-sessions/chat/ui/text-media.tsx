import { useState } from "react";
import { ImageIcon } from "lucide-react";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { usePathBase } from "../hooks/use-path-base";
import { useRevealedImage } from "../hooks/use-revealed-images";
import type { ChatMedia } from "../model/media";
import { textImageParts, type TextImage } from "../model/text-media";
import { ChatMediaView } from "./chat-media";
import * as m from "@/paraglide/messages.js";

/**
 * A run of images of the agent's text at its place (`08` R3): local files
 * and `data:` images as the media of the chat, external images as cards
 * that load nothing until the user asks.
 */
export function TextImages({ images }: { images: TextImage[] }) {
  const parts = textImageParts(images, usePathBase());
  if (parts.length === 0) return null;
  return (
    <div className="my-2 flex min-w-0 flex-col gap-2" data-text-media>
      {parts.map((part, index) => {
        switch (part.type) {
          case "media":
            return (
              <ChatMediaView key={index} session={null} media={part.media} />
            );
          case "external":
            return (
              <ExternalImage
                key={`${index}:${part.url}`}
                url={part.url}
                host={part.host}
                alt={part.alt}
              />
            );
          case "text":
            return (
              <span key={index} data-markdown-reader-blocked-image>
                {part.text}
              </span>
            );
        }
      })}
    </div>
  );
}

/**
 * An image from an external address: a card until the user shows it, then
 * a tile loaded without a referrer for as long as the timeline is open; a
 * failed load is the card again with its reason.
 */
function ExternalImage({
  url,
  host,
  alt,
}: {
  url: string;
  host: string;
  alt: string;
}) {
  const [revealed, reveal] = useRevealedImage(url);
  const [failed, setFailed] = useState(false);
  const title = m.sessions_chat_external_image({ host });
  if (revealed && !failed) {
    const media: ChatMedia = {
      key: url,
      kind: "image",
      name: alt || host,
      mimeType: null,
      size: null,
      path: null,
      data: null,
      url,
    };
    return (
      <ChatMediaView
        session={null}
        media={[media]}
        onFail={() => setFailed(true)}
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="group"
          aria-label={title}
          className="flex min-w-0"
          data-external-image={url}
        >
          <Attachment
            size="sm"
            state={failed ? "error" : "idle"}
            className="max-w-sm"
          >
            <AttachmentMedia>
              <ImageIcon />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle>{title}</AttachmentTitle>
              {(failed || alt) && (
                <AttachmentDescription>
                  {failed ? m.sessions_chat_external_image_failed() : alt}
                </AttachmentDescription>
              )}
            </AttachmentContent>
            <AttachmentActions>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  setFailed(false);
                  reveal();
                }}
              >
                {m.sessions_chat_external_image_show()}
              </Button>
            </AttachmentActions>
          </Attachment>
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm break-all">{url}</TooltipContent>
    </Tooltip>
  );
}
