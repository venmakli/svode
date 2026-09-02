import type { Page } from "@/features/page";
import type {
  ActorCandidate,
  Column,
  CollectionPropertyDefinition,
} from "@/features/properties";
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
  entry: Page;
  cover: GalleryResolvedCover | null;
  cardFields: string[];
  properties: readonly CollectionPropertyDefinition<Page>[];
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
  onUpdateField?: (entry: Page, column: Column, value: unknown) => void;
  onOpen: (entry: Page, nestedCollection: boolean) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicate: (entry: Page) => void;
  onDelete: (entry: Page) => void;
  onFocusCard: (path: string) => void;
  onKeyboardMove: (path: string, key: GalleryNavigationKey) => void;
  cardRef?: (element: HTMLElement | null) => void;
}
