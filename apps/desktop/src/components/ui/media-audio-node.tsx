import * as React from "react";

import type { TAudioElement } from "platejs";
import type { PlateElementProps } from "platejs/react";

import { useMediaState } from "@platejs/media/react";
import { ResizableProvider } from "@platejs/resizable";
import { PlateElement, withHOC } from "platejs/react";

import { useNearViewport } from "@/shared/hooks/use-near-viewport";

import { Caption, CaptionTextarea } from "./caption";
import { useResolvedMediaUrl } from "./media-adapter";

export const AudioElement = withHOC(
  ResizableProvider,
  function AudioElement(props: PlateElementProps<TAudioElement>) {
    const { align = "center", readOnly, unsafeUrl } = useMediaState();
    const [frameRef, shouldResolve] = useNearViewport<HTMLDivElement>();
    const resolvedUrl = useResolvedMediaUrl(
      shouldResolve ? unsafeUrl : undefined,
    );

    return (
      <PlateElement {...props} className="mb-1">
        <figure
          className="group relative cursor-default"
          contentEditable={false}
        >
          <div ref={frameRef} className="h-16">
            <audio
              className="size-full"
              src={resolvedUrl}
              preload="none"
              controls
            />
          </div>

          <Caption style={{ width: "100%" }} align={align}>
            <CaptionTextarea
              className="h-20"
              readOnly={readOnly}
              placeholder="Write a caption..."
            />
          </Caption>
        </figure>
        {props.children}
      </PlateElement>
    );
  },
);
