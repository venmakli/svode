export type {
  ActorCandidate,
  ChangeSchemaTypeResult,
  CollectionSchema,
  ColorName,
  Column,
  DateDisplay,
  DateRangeValue,
  EntrySchemaResult,
  NumberDisplay,
  PropertyOption,
  PropertySensitivity,
  PropertyType,
  RelationContext,
  RelationDriftKind,
  RelationDriftRow,
  RelationDriftSummary,
  RelationTarget,
  RelationTwoWayDiagnostics,
  RelationTwoWaySchemaStatus,
  ResolvedRelationEntry,
  SchemaMutationWarning,
  StatusGroup,
} from "./model/types";
export type {
  PropertyValidationCode,
  PropertyValidationState,
} from "./model/validation";
export {
  shouldClosePropertyEditorOnChange,
  validatePropertyValue,
} from "./model/validation";
export {
  PROPERTY_TYPES,
  actorDisplayName,
  initialsForActor,
  isDateRangeValue,
  isEmptyValue,
  isSensitiveColumn,
  isSensitivePropertyType,
  normalizeSchema,
  optionByName,
  valueToString,
} from "./lib/utils";
