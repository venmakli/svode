import type { CSSProperties } from "react";
import type { ColorName } from "@/features/properties";
import type { GalleryResolvedCover } from "../../model/gallery-cover-types";

const COVER_GRADIENTS: Record<ColorName, string> = {
  neutral:
    "linear-gradient(135deg, oklch(0.94 0.02 255), oklch(0.88 0.03 255))",
  gray: "linear-gradient(135deg, oklch(0.93 0.02 250), oklch(0.84 0.03 250))",
  red: "linear-gradient(135deg, oklch(0.9 0.12 25), oklch(0.78 0.16 25))",
  orange: "linear-gradient(135deg, oklch(0.92 0.12 60), oklch(0.84 0.16 40))",
  yellow: "linear-gradient(135deg, oklch(0.93 0.12 95), oklch(0.86 0.16 85))",
  green: "linear-gradient(135deg, oklch(0.92 0.12 145), oklch(0.82 0.18 165))",
  blue: "linear-gradient(135deg, oklch(0.88 0.14 250), oklch(0.78 0.18 270))",
  purple:
    "linear-gradient(135deg, oklch(0.88 0.14 295), oklch(0.82 0.16 320))",
  pink: "linear-gradient(135deg, oklch(0.9 0.13 340), oklch(0.82 0.16 350))",
  brown: "linear-gradient(135deg, oklch(0.88 0.07 70), oklch(0.76 0.09 60))",
};

export function coverStyle(cover: GalleryResolvedCover | null): CSSProperties {
  if (!cover || cover.kind === "icon" || cover.kind === "initial") {
    return { background: COVER_GRADIENTS.neutral };
  }
  if (cover.kind === "color") {
    return {
      background: COVER_GRADIENTS[cover.value] ?? COVER_GRADIENTS.neutral,
    };
  }
  return { background: COVER_GRADIENTS.neutral };
}
