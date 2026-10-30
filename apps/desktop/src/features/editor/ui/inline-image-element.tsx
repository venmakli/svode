import * as React from "react";
import { ImagePreviewStore } from "@platejs/media/react";
import { ImageOffIcon } from "lucide-react";
import { KEYS, type SlateEditor } from "platejs";
import {
  PlateElement,
  type PlateElementProps,
  useFocused,
  useReadOnly,
  useSelected,
} from "platejs/react";

import { useResolvedMediaUrl } from "@/components/ui/media-adapter";
import { Skeleton } from "@/components/ui/skeleton";
import * as m from "@/paraglide/messages.js";
import { useNearViewport } from "@/shared/hooks/use-near-viewport";
import { cn } from "@/shared/lib/utils";

import {
  INLINE_IMAGE_KEY,
  type InlineImageElement as TInlineImageElement,
} from "../model/markdown-inline-image";

function fileNameOf(url: string): string {
  const name = url.split(/[?#]/, 1)[0].split("/").pop() ?? "";
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Opens the image preview of the block image on this inline image; the
 * preview goes through every image of the document in order.
 */
function openInlineImagePreview(
  editor: SlateEditor,
  element: TInlineImageElement,
) {
  const previewList = Array.from(
    editor.api.nodes<TInlineImageElement>({
      at: [],
      match: (node) =>
        (node as { type?: string }).type === KEYS.img ||
        (node as { type?: string }).type === INLINE_IMAGE_KEY,
    }),
    ([node]) => ({ id: node.id as string, url: node.url }),
  );
  ImagePreviewStore.set("openEditorId", editor.id);
  ImagePreviewStore.set("currentPreview", {
    id: element.id as string,
    url: element.url,
  });
  ImagePreviewStore.set("previewList", previewList);
}

/** An image inside a line of text, at most one line high. */
export function InlineImageElement(
  props: PlateElementProps<TInlineImageElement>,
) {
  const { editor, element } = props;
  const selected = useSelected();
  const focused = useFocused();
  const readOnly = useReadOnly();
  const [frameRef, shouldResolve] = useNearViewport<HTMLSpanElement>();
  const resolvedUrl = useResolvedMediaUrl(
    shouldResolve ? element.url : undefined,
  );
  const [status, setStatus] = React.useState<"loading" | "loaded" | "failed">(
    "loading",
  );
  const name = element.alt || fileNameOf(element.url);

  React.useEffect(() => {
    setStatus("loading");
  }, [resolvedUrl]);

  return (
    <PlateElement {...props} as="span">
      <span
        ref={frameRef}
        contentEditable={false}
        className={cn(
          "relative mx-px inline-flex max-w-full items-center rounded-sm align-middle select-none",
          !readOnly && selected && focused && "ring-2 ring-ring",
        )}
        onDoubleClick={() => openInlineImagePreview(editor, element)}
      >
        {status === "failed" ? (
          <span
            role="img"
            aria-label={m.editor_inline_image_failed({ name })}
            className="inline-flex items-center gap-1 text-muted-foreground"
          >
            <ImageOffIcon aria-hidden className="size-[1em] shrink-0" />
            <span className="truncate">{name}</span>
          </span>
        ) : (
          <>
            {status === "loading" && (
              <Skeleton
                role={resolvedUrl ? undefined : "img"}
                aria-label={resolvedUrl ? undefined : name}
                aria-busy
                className="inline-block h-[1lh] w-[1lh] rounded-sm"
              />
            )}
            {resolvedUrl ? (
              <img
                src={resolvedUrl}
                alt={name}
                draggable={false}
                decoding="async"
                loading="lazy"
                className={cn(
                  "h-[1lh] w-auto max-w-full rounded-sm object-contain",
                  status === "loading" && "absolute opacity-0",
                )}
                onLoad={() => setStatus("loaded")}
                onError={() => setStatus("failed")}
              />
            ) : null}
          </>
        )}
      </span>
      {props.children}
    </PlateElement>
  );
}
