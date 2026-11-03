export * from "./ui/collection-property-panel";
export type {
  CollectionPropertyConflictEntry,
  CollectionPropertyConflictSide,
  CollectionPropertyConflictVariant,
  CollectionPropertyPanelConflict,
} from "./model/collection-property-conflict";
export type {
  CollectionPropertyFact,
  CollectionPropertyFactGroup,
  CollectionPropertyFactValue,
} from "./model/collection-property-fact";
export { keepsCollectionPropertyEditorOnEscape } from "./ui/collection-property-editor";
export {
  useCollectionSchemaPanel,
  type CollectionSchemaPanel,
} from "./hooks/use-collection-schema-panel";
