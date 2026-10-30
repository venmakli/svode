import { createPlatePlugin } from "platejs/react";

import { INLINE_IMAGE_KEY } from "../model/markdown-inline-image";
import { InlineImageElement } from "../ui/inline-image-element";

export const InlineImagePlugin = createPlatePlugin({
  key: INLINE_IMAGE_KEY,
  node: {
    isElement: true,
    isInline: true,
    isVoid: true,
    component: InlineImageElement,
  },
});
