import type { ColorName } from "@/features/properties";

export type GalleryResolvedCover =
  | {
      kind: "color";
      value: ColorName;
    }
  | {
      kind: "image";
      src: string;
      position: number;
    }
  | {
      kind: "icon" | "initial";
      value: string;
    };
