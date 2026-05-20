import { useEffect, useMemo, useState } from "react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  Copy,
  Database,
  FileText,
  FolderOpen,
  MoreVertical,
  Pencil,
  Plus,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ButtonGroup,
  ButtonGroupSeparator,
} from "@/components/ui/button-group";
import { cn } from "@/lib/utils";
import { MultiPanePopover } from "@/features/collection/query";
import type { CollectionSchema } from "@/features/properties/model";
import type { TemplateInfo, TemplateKind } from "../model";
import { templateIsDefault } from "../model";
import { handleError } from "../lib/errors";
import { SettingsRow, SettingsSection } from "./settings-row";
import * as m from "@/paraglide/messages.js";

const typeIcons = {
  leaf: FileText,
  folder: FolderOpen,
  nestedCollection: Database,
} satisfies Record<TemplateKind, typeof FileText>;

type TemplatesPane = "main" | "templateActions" | "newTemplate";

interface TemplatesSplitButtonProps {
  schema: CollectionSchema;
  disabled?: boolean;
  onPrimaryCreate: (asFolder: boolean) => void;
  onLoadTemplates: () => Promise<TemplateInfo[]>;
  onCreateTemplate: (kind: TemplateKind) => Promise<void>;
  onInstantiateTemplate: (
    template: TemplateInfo,
    forceFolder: boolean,
  ) => Promise<void>;
  onEditTemplate: (template: TemplateInfo) => Promise<void>;
  onSetDefaultTemplate: (slug: string | null) => Promise<void>;
  onDuplicateTemplate: (template: TemplateInfo) => Promise<void>;
  onDeleteTemplate: (template: TemplateInfo) => Promise<void>;
  onReorderTemplates: (slugs: string[]) => Promise<void>;
}

export function TemplatesSplitButton({
  schema,
  disabled,
  onPrimaryCreate,
  onLoadTemplates,
  onCreateTemplate,
  onInstantiateTemplate,
  onEditTemplate,
  onSetDefaultTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  onReorderTemplates,
}: TemplatesSplitButtonProps) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<TemplatesPane>("main");
  const [loading, setLoading] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [orderedSlugs, setOrderedSlugs] = useState<string[]>([]);
  const [activeTemplate, setActiveTemplate] = useState<TemplateInfo | null>(
    null,
  );
  const defaultSlug = schema.templates?.default ?? null;
  const missingDefault = Boolean(
    templatesLoaded &&
    defaultSlug &&
    !templates.some((template) => template.slug === defaultSlug),
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const sortedTemplates = useMemo(() => {
    const bySlug = new Map(
      templates.map((template) => [template.slug, template]),
    );
    return orderedSlugs
      .map((slug) => bySlug.get(slug))
      .filter((template): template is TemplateInfo => Boolean(template));
  }, [orderedSlugs, templates]);

  async function loadTemplates() {
    setLoading(true);
    try {
      const next = await onLoadTemplates();
      setTemplates(next);
      setOrderedSlugs(next.map((template) => template.slug));
      setTemplatesLoaded(true);
    } catch (error) {
      handleError(error);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadTemplates();
  }, [open]);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (nextOpen) {
      setPane("main");
      setActiveTemplate(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    const activeSlug = String(event.active.id);
    const overSlug = String(event.over.id);
    const oldIndex = orderedSlugs.indexOf(activeSlug);
    const newIndex = orderedSlugs.indexOf(overSlug);
    if (oldIndex < 0 || newIndex < 0) return;

    const previous = orderedSlugs;
    const next = arrayMove(orderedSlugs, oldIndex, newIndex);
    setOrderedSlugs(next);
    try {
      await onReorderTemplates(next);
    } catch (error) {
      setOrderedSlugs(previous);
      handleError(error);
    }
  }

  async function runAndClose(action: () => Promise<void>) {
    await action();
    setOpen(false);
  }

  async function runAndReturnToMain(action: () => Promise<void>) {
    await action();
    await loadTemplates();
    setPane("main");
    setActiveTemplate(null);
  }

  function openTemplateActions(template: TemplateInfo) {
    setActiveTemplate(template);
    setPane("templateActions");
  }

  const panes = [
    {
      id: "main" as const,
      title: m.collection_templates(),
      content: (
        <div className="flex flex-col p-1">
          <SettingsSection label={m.collection_templates()} />
          {missingDefault ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {m.collection_default_template_missing()}
            </div>
          ) : null}
          {loading ? (
            <div className="px-2 py-1.5 text-sm text-muted-foreground">
              {m.collection_templates_loading()}
            </div>
          ) : sortedTemplates.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedSlugs}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col gap-0.5">
                  {sortedTemplates.map((template) => (
                    <SortableTemplateRow
                      key={template.slug}
                      template={template}
                      onInstantiate={(forceFolder) =>
                        void runAndClose(() =>
                          onInstantiateTemplate(template, forceFolder),
                        ).catch(handleError)
                      }
                      onOpenActions={() => openTemplateActions(template)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          ) : (
            <div className="flex min-h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground">
              <FileText data-icon="inline-start" />
              <span>{m.collection_templates_empty()}</span>
            </div>
          )}
        </div>
      ),
      footer: (
        <SettingsRow
          icon={Plus}
          label={m.collection_new_template()}
          onClick={() => setPane("newTemplate")}
        />
      ),
    },
    {
      id: "templateActions" as const,
      title: activeTemplate?.title || activeTemplate?.slug || m.entry_actions(),
      content: activeTemplate ? (
        <div className="flex flex-col p-1">
          <SettingsRow
            icon={Pencil}
            label={m.collection_template_edit()}
            right={null}
            onClick={() =>
              void runAndClose(() => onEditTemplate(activeTemplate)).catch(
                handleError,
              )
            }
          />
          {templateIsDefault(activeTemplate) ? (
            <SettingsRow
              icon={StarOff}
              label={m.collection_template_unset_default()}
              right={null}
              onClick={() =>
                void runAndReturnToMain(() => onSetDefaultTemplate(null)).catch(
                  handleError,
                )
              }
            />
          ) : (
            <SettingsRow
              icon={Star}
              label={m.collection_template_set_default()}
              right={null}
              onClick={() =>
                void runAndReturnToMain(() =>
                  onSetDefaultTemplate(activeTemplate.slug),
                ).catch(handleError)
              }
            />
          )}
          <SettingsRow
            icon={Copy}
            label={m.collection_template_duplicate()}
            right={null}
            onClick={() =>
              void runAndReturnToMain(() =>
                onDuplicateTemplate(activeTemplate),
              ).catch(handleError)
            }
          />
          <SettingsRow
            icon={Trash2}
            label={m.collection_template_delete()}
            right={null}
            destructive
            onClick={() =>
              void runAndReturnToMain(() =>
                onDeleteTemplate(activeTemplate),
              ).catch(handleError)
            }
          />
        </div>
      ) : (
        <div className="px-3 py-2 text-sm text-muted-foreground">
          {m.collection_templates_empty()}
        </div>
      ),
    },
    {
      id: "newTemplate" as const,
      title: m.collection_new_template(),
      content: (
        <div className="flex flex-col p-1">
          <SettingsRow
            icon={FileText}
            label={m.collection_template_type_leaf()}
            right={null}
            onClick={() =>
              void runAndClose(() => onCreateTemplate("leaf")).catch(
                handleError,
              )
            }
          />
          <SettingsRow
            icon={FolderOpen}
            label={m.collection_template_type_folder()}
            right={null}
            onClick={() =>
              void runAndClose(() => onCreateTemplate("folder")).catch(
                handleError,
              )
            }
          />
          <SettingsRow
            icon={Database}
            label={m.collection_template_type_nested_collection()}
            right={null}
            onClick={() =>
              void runAndClose(() =>
                onCreateTemplate("nestedCollection"),
              ).catch(handleError)
            }
          />
        </div>
      ),
    },
  ];

  return (
    <ButtonGroup>
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        onClick={(event) => onPrimaryCreate(event.shiftKey)}
      >
        <Plus data-icon="inline-start" />
        {m.collection_new_entry()}
      </Button>
      <ButtonGroupSeparator />
      <MultiPanePopover
        open={open}
        pane={pane}
        onOpenChange={handleOpenChange}
        onPaneChange={setPane}
        mainPane="main"
        panes={panes}
        className="w-72"
        trigger={
          <Button
            type="button"
            size="icon-sm"
            disabled={disabled}
            aria-label={m.collection_templates()}
          >
            <ChevronDown />
          </Button>
        }
      />
    </ButtonGroup>
  );
}

function SortableTemplateRow({
  template,
  onInstantiate,
  onOpenActions,
}: {
  template: TemplateInfo;
  onInstantiate: (forceFolder: boolean) => void;
  onOpenActions: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: template.slug });
  const TypeIcon = typeIcons[template.kind];
  const isDefault = templateIsDefault(template);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group/template-row relative min-w-0",
        isDragging && "opacity-50",
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <Button
        type="button"
        variant="ghost"
        size="default"
        className="min-h-8 w-full cursor-grab justify-start gap-2 rounded-md px-2 py-1.5 pr-8 text-[13px] font-normal active:cursor-grabbing [&_svg:not([class*='size-'])]:size-3.5"
        onClick={(event) => onInstantiate(event.shiftKey)}
        {...attributes}
        {...listeners}
      >
        <TypeIcon className="text-muted-foreground" data-icon="inline-start" />
        <span className="shrink-0 leading-none">{template.icon || ""}</span>
        <span className="min-w-0 flex-1 truncate text-left font-medium">
          {template.title || template.slug}
        </span>
        {isDefault ? (
          <span className="shrink-0 text-[11.5px] font-medium text-muted-foreground">
            ★ {m.collection_template_default_badge()}
          </span>
        ) : null}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={m.entry_actions()}
        aria-haspopup="menu"
        className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenActions();
        }}
      >
        <MoreVertical data-icon="inline-end" />
      </Button>
    </div>
  );
}
