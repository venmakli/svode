import type { Entry } from "@/features/entry";
import type { ActorCandidate, Column } from "@/features/properties";
import type { ListRowModel } from "../../model/list-types";

export type { ListRowModel, ListViewProps } from "../../model/list-types";

export interface ListRowProps {
  row: ListRowModel;
  density: "compact" | "comfortable";
  cardFields: string[];
  metaColumns: Column[];
  spacePath: string;
  projectPath?: string | null;
  actors: ActorCandidate[];
  disabledReorder: boolean;
  focused: boolean;
  onRequestActors: (allTime: boolean) => Promise<ActorCandidate[]>;
  onUpdateField: (entry: Entry, column: Column, value: unknown) => void;
  onToggle: (entry: Entry) => void;
  onOpen: (entry: Entry, nestedCollection: boolean) => void;
  onOpenFullPage: (entry: Entry) => void;
  onOpenNestedCollection: (entry: Entry) => void;
  onOpenPath: (path: string) => void;
  onDuplicate: (entry: Entry) => void;
  onDelete: (entry: Entry) => void;
  onFocusRow: (path: string) => void;
  onKeyboardMove: (path: string, offset: number) => void;
  rowRef?: (element: HTMLElement | null) => void;
}
