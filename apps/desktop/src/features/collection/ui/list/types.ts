import type { Page } from "@/features/page";
import type {
  ActorCandidate,
  Column,
  CollectionPropertyDefinition,
} from "@/features/properties";
import type { ListRowModel } from "../../model/list-types";

export type { ListRowModel, ListViewProps } from "../../model/list-types";

export interface ListRowProps {
  row: ListRowModel;
  density: "compact" | "comfortable";
  cardFields: string[];
  properties: readonly CollectionPropertyDefinition<Page>[];
  spacePath: string;
  projectPath?: string | null;
  actors: ActorCandidate[];
  disabledReorder: boolean;
  focused: boolean;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (item: Page, column: Column, value: unknown) => void;
  onToggle: (item: Page) => void;
  onOpen: (item: Page, nestedCollection: boolean) => void;
  onOpenNestedCollection: (item: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onFocusRow: (path: string) => void;
  onKeyboardMove: (path: string, offset: number) => void;
  rowRef?: (element: HTMLElement | null) => void;
}
