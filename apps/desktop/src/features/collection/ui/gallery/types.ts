import type { Entry } from "@/features/entry";
import type { ActorCandidate, Column } from "@/features/properties";
import type { GalleryResolvedCover } from "../../model/gallery-cover-types";

export type { GalleryViewProps } from "../../model/gallery-types";

export type GalleryNavigationKey =
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "End"
  | "Home";

export interface GalleryCardProps {
  entry: Entry;
  cover: GalleryResolvedCover | null;
  cardFields: string[];
  metaColumns: Column[];
  coverFit: "cover" | "contain";
  coverAspect: string;
  spacePath: string;
  projectPath?: string | null;
  actors: ActorCandidate[];
  nestedCollection: boolean;
  folder: boolean;
  disabledReorder: boolean;
  readOnly: boolean;
  focused: boolean;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Entry, column: Column, value: unknown) => void;
  onOpen: (entry: Entry, nestedCollection: boolean) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicate: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onFocusCard: (path: string) => void;
  onKeyboardMove: (path: string, key: GalleryNavigationKey) => void;
  cardRef?: (element: HTMLElement | null) => void;
}
