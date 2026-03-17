import { useState, useCallback } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Plus, X } from "lucide-react";
import * as m from "@/paraglide/messages.js";

interface EntryMeta {
  id: string;
  title: string;
  icon: string | null;
  created: string;
  updated: string;
  extra: Record<string, unknown>;
}

const SYSTEM_FIELDS = new Set(["id", "title", "icon", "created", "updated"]);

interface FrontmatterPanelProps {
  meta: EntryMeta | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onExtraChange?: (extra: Record<string, unknown>) => void;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return dateStr;
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  return JSON.stringify(value);
}

export function FrontmatterPanel({
  meta,
  isOpen,
  onOpenChange,
  onExtraChange,
}: FrontmatterPanelProps) {
  const [newKey, setNewKey] = useState("");
  const [addingField, setAddingField] = useState(false);

  const handleExtraValueChange = useCallback(
    (key: string, value: string) => {
      if (!meta || !onExtraChange) return;
      onExtraChange({ ...(meta.extra ?? {}), [key]: value });
    },
    [meta, onExtraChange],
  );

  const handleRemoveField = useCallback(
    (key: string) => {
      if (!meta || !onExtraChange) return;
      const { [key]: _, ...rest } = (meta.extra ?? {});
      onExtraChange(rest);
    },
    [meta, onExtraChange],
  );

  const handleAddField = useCallback(() => {
    const trimmed = newKey.trim();
    if (!trimmed || !meta || !onExtraChange) return;
    if (SYSTEM_FIELDS.has(trimmed) || trimmed in (meta.extra ?? {})) return;
    onExtraChange({ ...(meta.extra ?? {}), [trimmed]: "" });
    setNewKey("");
    setAddingField(false);
  }, [newKey, meta, onExtraChange]);

  if (!meta) return null;

  const extraEntries = Object.entries((meta.extra ?? {}) ?? {}).filter(
    ([key]) => !SYSTEM_FIELDS.has(key),
  );

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange} className="mb-4">
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full group">
          <Separator className="group-hover:bg-primary/30 transition-colors" />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-3 pb-2">
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wider">
            {m.editor_frontmatter_toggle()}
          </p>
          <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm items-center">
            {/* System fields — read-only */}
            <span className="text-muted-foreground">id</span>
            <span className="text-muted-foreground font-mono text-xs truncate">
              {meta.id}
            </span>

            <span className="text-muted-foreground">created</span>
            <span className="text-muted-foreground">
              {formatDate(meta.created)}
            </span>

            <span className="text-muted-foreground">updated</span>
            <span className="text-muted-foreground">
              {formatDate(meta.updated)}
            </span>

            {/* Custom fields — editable */}
            {extraEntries.map(([key, value]) => (
              <div key={key} className="contents">
                <span className="text-foreground flex items-center gap-1">
                  {key}
                  <Badge variant="outline" className="text-[9px] px-1 py-0">
                    custom
                  </Badge>
                </span>
                <div className="flex items-center gap-1">
                  <Input
                    value={formatValue(value)}
                    onChange={(e) => handleExtraValueChange(key, e.target.value)}
                    className="h-7 text-sm"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleRemoveField(key)}
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          {/* Add custom field */}
          {addingField ? (
            <form
              className="flex items-center gap-2 mt-2"
              onSubmit={(e) => {
                e.preventDefault();
                handleAddField();
              }}
            >
              <Input
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={m.editor_frontmatter_key_placeholder()}
                className="h-7 text-sm flex-1"
                autoFocus
              />
              <Button type="submit" size="sm" className="h-7 px-2 text-xs">
                {m.editor_frontmatter_add()}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => {
                  setAddingField(false);
                  setNewKey("");
                }}
              >
                {m.project_cancel()}
              </Button>
            </form>
          ) : (
            <button
              type="button"
              className="flex items-center gap-1 mt-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAddingField(true)}
            >
              <Plus className="h-3 w-3" />
              {m.editor_frontmatter_add_field()}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
