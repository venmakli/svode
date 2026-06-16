import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import type { EntryMeta } from "@/features/entry";
import { PropertyPanel } from "@/features/properties";
import type { EntrySchemaResult } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import { useEffect, useState } from "react";

interface FrontmatterPanelProps {
  meta: EntryMeta | null;
  spacePath: string;
  projectPath?: string | null;
  filePath: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onPropertyChange: (field: string, value: unknown) => Promise<void>;
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
  spacePath,
  projectPath,
  filePath,
  isOpen,
  onOpenChange,
  onPropertyChange,
}: FrontmatterPanelProps) {
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!spacePath || !filePath) {
      setSchemaResult(null);
      return;
    }
    invoke<EntrySchemaResult | null>("get_entry_schema", {
      space: spacePath,
      filePath,
    })
      .then((result) => {
        if (!cancelled) setSchemaResult(result);
      })
      .catch(() => {
        if (!cancelled) setSchemaResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, spacePath]);

  if (!meta) return null;

  const extraEntries = Object.entries((meta.extra ?? {}) ?? {});

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange} className="mb-1">
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
          </div>

          {schemaResult && filePath ? (
            <div className="mt-3">
              <PropertyPanel
                spacePath={spacePath}
                projectPath={projectPath}
                filePath={filePath}
                metaId={meta.id}
                schemaResult={schemaResult}
                values={meta.extra ?? {}}
                onValueChange={onPropertyChange}
                onSchemaChange={setSchemaResult}
              />
            </div>
          ) : extraEntries.length > 0 ? (
            <details className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {m.editor_raw_yaml_toggle({ count: String(extraEntries.length) })}
              </summary>
              <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
                {extraEntries.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                      {formatValue(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
