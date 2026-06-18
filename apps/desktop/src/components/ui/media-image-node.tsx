import * as React from "react";

import type { TImageElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { useDraggable } from "@platejs/dnd";
import { Image, ImagePlugin, useMediaState } from "@platejs/media/react";
import { ResizableProvider, useResizableValue } from "@platejs/resizable";
import { PlateElement, withHOC } from "platejs/react";

import { cn } from "@/shared/lib/utils";
import { useNearViewport } from "@/shared/hooks/use-near-viewport";

import { Caption, CaptionTextarea } from "./caption";
import { useResolvedMediaUrl } from "./media-adapter";
import { MediaToolbar } from "./media-toolbar";
import { Skeleton } from "./skeleton";
import {
  mediaResizeHandleVariants,
  Resizable,
  ResizeHandle,
} from "./resize-handle";

export const ImageElement = withHOC(
  ResizableProvider,
  function ImageElement(props: PlateElementProps<TImageElement>) {
    const {
      align = "center",
      focused,
      readOnly,
      selected,
      unsafeUrl,
    } = useMediaState();
    const width = useResizableValue("width");
    const [frameRef, shouldResolve] = useNearViewport<HTMLDivElement>();
    const resolvedUrl = useResolvedMediaUrl(
      shouldResolve ? unsafeUrl : undefined,
    );
    const [imageReady, setImageReady] = React.useState(false);

    const { isDragging, handleRef } = useDraggable({
      element: props.element,
    });

    React.useEffect(() => {
      setImageReady(false);
    }, [resolvedUrl]);

    return (
      <MediaToolbar plugin={ImagePlugin}>
        <PlateElement {...props} className="py-2.5">
          <figure className="group relative m-0" contentEditable={false}>
            <Resizable
              align={align}
              options={{
                align,
                readOnly,
              }}
            >
              <ResizeHandle
                className={mediaResizeHandleVariants({ direction: "left" })}
                options={{ direction: "left" }}
              />
              <div ref={frameRef} className="relative min-h-40 w-full">
                {(!resolvedUrl || !imageReady) && (
                  <Skeleton className="absolute inset-0 h-full w-full rounded-sm" />
                )}
                {resolvedUrl ? (
                  <Image
                    ref={handleRef}
                    className={cn(
                      "block w-full max-w-full cursor-pointer object-cover px-0",
                      "rounded-sm",
                      focused && selected && "ring-2 ring-ring ring-offset-2",
                      isDragging && "opacity-50",
                      !imageReady && "opacity-0",
                    )}
                    alt={props.attributes.alt as string | undefined}
                    setProps={({ ...rest }) => ({
                      ...rest,
                      decoding: "async",
                      loading: "lazy",
                      onError: () => setImageReady(true),
                      onLoad: () => setImageReady(true),
                      src: resolvedUrl,
                    })}
                  />
                ) : null}
              </div>
              <ResizeHandle
                className={mediaResizeHandleVariants({
                  direction: "right",
                })}
                options={{ direction: "right" }}
              />
            </Resizable>

            <Caption style={{ width }} align={align}>
              <CaptionTextarea
                readOnly={readOnly}
                onFocus={(e) => {
                  e.preventDefault();
                }}
                placeholder="Write a caption..."
              />
            </Caption>
          </figure>

          {props.children}
        </PlateElement>
      </MediaToolbar>
    );
  },
);
