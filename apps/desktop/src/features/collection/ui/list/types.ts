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
  readOnly?: boolean;
  focused: boolean;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField?: (entry: Page, column: Column, value: unknown) => void;
  onToggle: (entry: Page) => void;
  onOpen: (entry: Page, nestedCollection: boolean) => void;
  onOpenNestedCollection: (entry: Page) => void;
  onOpenPath: (path: string, spaceId?: string | null) => void;
  onDuplicate: (entry: Page) => void;
  onDelete: (entry: Page) => void;
  onFocusRow: (path: string) => void;
  onKeyboardMove: (path: string, offset: number) => void;
  rowRef?: (element: HTMLElement | null) => void;
}
