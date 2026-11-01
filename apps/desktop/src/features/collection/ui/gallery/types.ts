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
  item: Page;
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
  focused: boolean;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (item: Page, column: Column, value: unknown) => void;
  onOpen: (item: Page, nestedCollection: boolean) => void;
  onOpenNestedCollection: (item: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onFocusCard: (path: string) => void;
  onKeyboardMove: (path: string, key: GalleryNavigationKey) => void;
  cardRef?: (element: HTMLElement | null) => void;
}
