import { AlertTriangle, Link2, RefreshCcw, Unlink, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ColumnPatch,
  CollectionSchema,
  Column,
  RelationRepairStrategy,
  RelationTwoWayDiagnostics,
} from "../../model/types";
import { useRelationSettings } from "../../hooks/use-relation-settings";
import { ColumnSelect, ToggleRow } from "./common";
import * as m from "@/paraglide/messages.js";

export function RelationSettingsPane({
  column,
  spacePath,
  collectionPath,
  projectPath,
  onSchemaChange,
  onPatchColumn,
}: {
  column: Column;
  spacePath: string;
  collectionPath: string;
  projectPath?: string | null;
  onSchemaChange: (schema: CollectionSchema) => void;
  onPatchColumn: (patch: ColumnPatch) => void | Promise<void>;
}) {
  const {
    relation,
    options,
    twoWay,
    twoWayAvailable,
    reverseName,
    setReverseName,
    diagnostics,
    diagnosticsLoading,
    selectedReverse,
    setSelectedReverse,
    repairing,
    patchRelation,
    patchRelationSelection,
    runRepair,
  } = useRelationSettings({
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
    onPatchColumn,
  });

  return (
    <div className="flex flex-col gap-2 p-3">
      <ColumnSelect
        label={m.property_relation_linked_collection()}
        value={relation}
        options={options}
        onChange={patchRelationSelection}
      />
      <ToggleRow
        label={m.property_relation_limit_one()}
        checked={column.limit === "one"}
        onChange={(checked) => patchRelation({ limit: checked ? "one" : null })}
      />
      {twoWayAvailable ? (
        <ToggleRow
          label={m.property_relation_show_related()}
          checked={twoWay}
          onChange={(checked) => {
            const fallback =
              reverseName.trim() || m.property_relation_reverse_default();
            if (checked) setReverseName(fallback);
            patchRelation({ twoWay: checked ? fallback : null });
          }}
        />
      ) : null}
      {twoWay ? (
        <label className="flex items-center gap-2 text-sm">
          <span className="w-20 text-muted-foreground">
            {m.property_relation_reverse_name()}
          </span>
          <Input
            value={reverseName}
            className="h-8 flex-1"
            placeholder={m.property_relation_reverse_default()}
            onChange={(event) => setReverseName(event.target.value)}
            onBlur={() => {
              const next = reverseName.trim();
              if (next) patchRelation({ twoWay: next });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
      ) : null}
      {twoWay ? (
        <RelationDiagnosticsPanel
          diagnostics={diagnostics}
          loading={diagnosticsLoading}
          selectedReverse={selectedReverse}
          reverseName={reverseName}
          repairing={repairing}
          onSelectReverse={setSelectedReverse}
          onRepair={runRepair}
        />
      ) : null}
    </div>
  );
}

function RelationDiagnosticsPanel({
  diagnostics,
  loading,
  selectedReverse,
  reverseName,
  repairing,
  onSelectReverse,
  onRepair,
}: {
  diagnostics: RelationTwoWayDiagnostics | null;
  loading: boolean;
  selectedReverse: string;
  reverseName: string;
  repairing: string | null;
  onSelectReverse: (value: string) => void;
  onRepair: (
    strategy: RelationRepairStrategy,
    reverseColumn?: string | null,
  ) => void | Promise<void>;
}) {
  if (loading || !diagnostics) return null;

  const schemaStatus = diagnostics.schemaStatus;
  const reverseColumn = diagnostics.reverseColumn ?? reverseName;
  const choices = diagnostics.compatibleReverseChoices;
  const drift = diagnostics.drift;
  const missingReverse = drift.missingReverseCount;
  const missingSource = drift.missingSourceCount;
  const hasSchemaWarning = schemaStatus !== "ok";
  const hasDrift = missingReverse + missingSource > 0;

  if (!hasSchemaWarning && !hasDrift) return null;

  const createName =
    reverseColumn?.trim() ||
    reverseName.trim() ||
    m.property_relation_reverse_default();
  const description = hasSchemaWarning
    ? (diagnostics.schemaMessage ?? schemaWarningDescription(schemaStatus))
    : m.property_relation_drift_counts({
        reverse: String(missingReverse),
        source: String(missingSource),
      });

  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
      <div className="flex gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {hasSchemaWarning
              ? m.property_relation_schema_warning()
              : m.property_relation_sync_warning()}
          </div>
          <div className="mt-0.5 text-muted-foreground">{description}</div>
        </div>
      </div>

      {hasSchemaWarning && choices.length > 0 ? (
        <div className="mt-2">
          <Select
            value={selectedReverse || choices[0]?.name}
            onValueChange={onSelectReverse}
          >
            <SelectTrigger className="h-7 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {choices.map((choice) => (
                  <SelectItem key={choice.name} value={choice.name}>
                    {choice.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {hasDrift ? (
          <>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={Boolean(repairing)}
              onClick={() => onRepair("from_this_side")}
            >
              <RefreshCcw data-icon="inline-start" />
              {m.property_relation_repair_this_side()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={Boolean(repairing)}
              onClick={() => onRepair("from_related_side")}
            >
              <RefreshCcw data-icon="inline-start" />
              {m.property_relation_repair_related_side()}
            </Button>
          </>
        ) : null}
        {hasSchemaWarning && choices.length > 0 ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={
              Boolean(repairing) || !(selectedReverse || choices[0]?.name)
            }
            onClick={() =>
              onRepair(
                "choose_reverse_column",
                selectedReverse || choices[0]?.name,
              )
            }
          >
            <Link2 data-icon="inline-start" />
            {m.property_relation_choose_reverse()}
          </Button>
        ) : null}
        {schemaStatus === "missing_reverse" ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={Boolean(repairing)}
            onClick={() => onRepair("create_reverse_column", createName)}
          >
            <Wrench data-icon="inline-start" />
            {m.property_relation_create_reverse()}
          </Button>
        ) : null}
        {hasSchemaWarning ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={Boolean(repairing)}
            onClick={() => onRepair("detach_two_way", reverseColumn)}
          >
            <Unlink data-icon="inline-start" />
            {m.property_relation_detach_two_way()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function schemaWarningDescription(
  status: RelationTwoWayDiagnostics["schemaStatus"],
) {
  if (status === "missing_reverse")
    return m.property_relation_missing_reverse();
  if (status === "incompatible_reverse") {
    return m.property_relation_incompatible_reverse();
  }
  return m.property_relation_schema_warning_desc();
}
