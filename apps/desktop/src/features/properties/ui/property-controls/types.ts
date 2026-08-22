import type {
  ActorCandidate,
  Column,
  RelationContext,
} from "../../model/types";

export interface PropertyControlProps {
  column: Column;
  value: unknown;
  invalid?: boolean;
  disabled?: boolean;
  autoOpen?: boolean;
  actors?: ActorCandidate[];
  relationContext?: RelationContext;
  relationPresentation?: "default" | "table";
  accessibilityLabel?: string;
  density?: "default" | "compact";
  onRequestActors?: (allTime: boolean) => Promise<ActorCandidate[]>;
  onChange: (value: unknown) => void | Promise<void>;
  onOpenChange?: (open: boolean) => void;
}
