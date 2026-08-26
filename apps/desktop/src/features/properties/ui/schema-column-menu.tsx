import { useState, type ComponentProps, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  Grid2X2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/shared/lib/utils";
import {
  MultiPanePopover,
  type MultiPaneDefinition,
} from "@/shared/ui/multi-pane-popover";
import { useSchemaColumnActions } from "../hooks/use-schema-column-actions";
import { isSensitiveColumn, isSensitivePropertyType } from "../lib/utils";
import type { CollectionSchema, Column, PropertyType } from "../model/types";
import { ChangeTypeDialog } from "./schema-dialogs";
import { TypeSettingsPane } from "./column-type-settings";
import {
  PROPERTY_TYPE_ICONS,
  propertyTypeLabel,
  propertyTypeSettingsMeta,
  SensitivePropertyTypeHint,
} from "./property-type-meta";
import * as m from "@/paraglide/messages.js";

export interface SchemaColumnMenuExtensionControls {
  close: () => void;
  openPane: (pane: string) => void;
}

interface SchemaColumnMenuProps {
  trigger: ReactNode;
  open: boolean;
  column: Column;
  schema: CollectionSchema;
  collectionPath: string;
  spacePath: string;
  projectPath?: string | null;
  affectedEntries?: number;
  extensionPanes?: Array<MultiPaneDefinition<string>>;
  renderMainExtension?: (
    controls: SchemaColumnMenuExtensionControls,
  ) => ReactNode;
  onOpenChange: (open: boolean) => void;
  onSchemaChange: (schema: CollectionSchema) => void;
  onRenameCommitted?: (
    oldName: string,
    newName: string,
    schema: CollectionSchema,
  ) => void | Promise<void>;
}

export function SchemaColumnMenu({
  trigger,
  open,
  column,
  schema,
  collectionPath,
  spacePath,
  projectPath,
  affectedEntries,
  extensionPanes = [],
  renderMainExtension,
  onOpenChange,
  onSchemaChange,
  onRenameCommitted,
}: SchemaColumnMenuProps) {
  const [pane, setPane] = useState("main");
  const [draftName, setDraftName] = useState(column.name);
  const [requestedType, setRequestedType] = useState<PropertyType | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteValues, setDeleteValues] = useState(false);
  const {
    changeColumnType,
    deleteColumn,
    duplicateColumn,
    pendingAction,
    renameColumn,
  } = useSchemaColumnActions({
    schema,
    column,
    spacePath,
    collectionPath,
    projectPath,
    onSchemaChange,
    onRenameCommitted,
  });
  const typeSettings = propertyTypeSettingsMeta(column);
  const disabled = pendingAction !== null;

  const extensionControls: SchemaColumnMenuExtensionControls = {
    close: () => onOpenChange(false),
    openPane: setPane,
  };
  const panes: Array<MultiPaneDefinition<string>> = [
    {
      id: "main",
      title: column.name,
      content: (
        <div className="flex flex-col p-1">
          <div className="p-1">
            <Input
              autoFocus
              value={draftName}
              disabled={disabled}
              aria-label={m.property_dialog_name()}
              className="h-9 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
              onChange={(event) => setDraftName(event.target.value)}
              onBlur={(event) => {
                const nextName = event.currentTarget.value.trim();
                if (!nextName || nextName === column.name) return;
                void renameColumn(nextName).then((renamed) => {
                  if (renamed) {
                    onOpenChange(false);
                  } else {
                    setDraftName(column.name);
                  }
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </div>
          <SchemaMenuSection label={m.collection_properties_label()} />
          <SchemaMenuRow
            icon={Grid2X2}
            label={m.table_column_type()}
            meta={propertyTypeLabel(column.type)}
            disabled={disabled}
            onClick={() => setPane("type")}
          />
          {renderMainExtension?.(extensionControls)}
          {typeSettings ? (
            <>
              <SchemaMenuSeparator />
              <SchemaMenuSection label={m.table_type_settings()} />
              <SchemaMenuRow
                icon={typeSettings.icon}
                label={typeSettings.label}
                disabled={disabled}
                onClick={() => setPane("settings")}
              />
            </>
          ) : null}
        </div>
      ),
      footer: (
        <TooltipProvider>
          <div className="flex flex-col">
            <SchemaMenuRow
              icon={Copy}
              label={m.table_duplicate_column()}
              right={null}
              disabled={disabled}
              onClick={() => void duplicateColumn()}
            />
            <SchemaMenuRow
              icon={Trash2}
              label={m.table_delete_column()}
              right={
                isSensitiveColumn(column) ? <SensitivePropertyTypeHint /> : null
              }
              destructive
              disabled={disabled}
              onClick={() => setDeleteOpen(true)}
            />
          </div>
        </TooltipProvider>
      ),
    },
    {
      id: "type",
      title: m.table_column_type(),
      content: (
        <PropertyTypeMenuPane
          activeType={column.type}
          disabled={disabled}
          disableActive
          onSelect={(type) => {
            setRequestedType(type);
            onOpenChange(false);
          }}
        />
      ),
      notice: m.property_dialog_change_type_desc(),
    },
    {
      id: "settings",
      title: m.table_type_settings(),
      content: (
        <TypeSettingsPane
          column={column}
          spacePath={spacePath}
          collectionPath={collectionPath}
          projectPath={projectPath}
          onSchemaChange={onSchemaChange}
        />
      ),
    },
    ...extensionPanes,
  ];

  return (
    <>
      <MultiPanePopover
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setPane("main");
            setDraftName(column.name);
          }
          onOpenChange(nextOpen);
        }}
        pane={pane}
        onPaneChange={setPane}
        mainPane="main"
        panes={panes}
        trigger={trigger}
        className="w-[260px]"
      />
      <ChangeTypeDialog
        open={requestedType !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setRequestedType(null);
        }}
        column={column}
        initialType={requestedType}
        collectionPath={collectionPath}
        onSubmit={async (newType, conversionStrategy) => {
          if (await changeColumnType(newType, conversionStrategy)) {
            setRequestedType(null);
          }
        }}
      />
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {m.property_dialog_delete_column_title()}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {m.property_dialog_delete_column_desc({ name: column.name })}
              {affectedEntries === undefined
                ? null
                : ` ${m.table_delete_column_affected({ count: affectedEntries })}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={deleteValues}
              onCheckedChange={(checked) => setDeleteValues(checked === true)}
            />
            {m.property_dialog_delete_values()}
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>{m.settings_cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void deleteColumn(deleteValues);
                onOpenChange(false);
              }}
            >
              {m.table_delete_column()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

type PropertyLabelTriggerProps = Omit<
  ComponentProps<typeof Button>,
  "children"
> & {
  column: Column;
  open: boolean;
};

export function PropertyLabelTrigger({
  column,
  open,
  className,
  ...props
}: PropertyLabelTriggerProps) {
  const Icon = PROPERTY_TYPE_ICONS[column.type];
  return (
    <Button
      {...props}
      type="button"
      variant="ghost"
      size="default"
      aria-label={m.property_column_menu_label({
        name: column.name,
        type: propertyTypeLabel(column.type),
      })}
      data-property-label-trigger={column.name}
      data-property-type={column.type}
      className={cn(
        "min-w-0 w-full justify-start gap-1.5 px-1.5 font-normal text-muted-foreground",
        open && "bg-muted text-foreground",
        className,
      )}
    >
      <Icon aria-hidden="true" data-icon="inline-start" />
      <span className="min-w-0 truncate">{column.name}</span>
    </Button>
  );
}

export function SchemaMenuSection({ label }: { label: string }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.04em] text-muted-foreground">
      {label}
    </div>
  );
}

export function SchemaMenuSeparator() {
  return <Separator className="mx-1 my-1 w-auto" />;
}

export function SchemaMenuRow({
  icon: Icon,
  label,
  meta,
  right,
  onClick,
  disabled,
  destructive,
}: {
  icon: LucideIcon;
  label: string;
  meta?: string;
  right?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="default"
      className={cn(
        "min-h-8 w-full justify-start gap-2.5 rounded-md px-2 py-1.5 text-[13px] font-normal",
        "[&_svg:not([class*='size-'])]:size-3.5",
        destructive &&
          "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive",
      )}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon
        className={cn("text-muted-foreground", destructive && "text-current")}
        data-icon="inline-start"
      />
      <span className="min-w-0 flex-1 truncate text-left font-medium">
        {label}
      </span>
      {meta ? (
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {meta}
        </span>
      ) : null}
      {right !== undefined ? (
        right
      ) : onClick ? (
        <ChevronRight
          className={cn(
            "text-muted-foreground",
            destructive && "text-destructive",
          )}
          data-icon="inline-end"
        />
      ) : null}
    </Button>
  );
}

export function PropertyTypeMenuPane({
  activeType,
  disabled = false,
  disableActive = false,
  onSelect,
}: {
  activeType: PropertyType;
  disabled?: boolean;
  disableActive?: boolean;
  onSelect: (type: PropertyType) => void;
}) {
  return (
    <TooltipProvider>
      <div className="p-1">
        {Object.entries(PROPERTY_TYPE_ICONS).map(([type, Icon]) => {
          const propertyType = type as PropertyType;
          const active = propertyType === activeType;
          return (
            <SchemaMenuRow
              key={type}
              icon={Icon}
              label={propertyTypeLabel(propertyType)}
              disabled={disabled || (disableActive && active)}
              right={
                <span className="flex items-center gap-2">
                  {isSensitivePropertyType(propertyType) ? (
                    <SensitivePropertyTypeHint />
                  ) : null}
                  {active ? <Check data-icon="inline-end" /> : null}
                </span>
              }
              onClick={() => onSelect(propertyType)}
            />
          );
        })}
      </div>
    </TooltipProvider>
  );
}
