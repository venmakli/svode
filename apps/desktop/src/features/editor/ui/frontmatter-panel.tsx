import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import type { EntryMeta } from "@/features/entry";
import { PropertyPanel } from "@/features/properties/panel";
import * as m from "@/paraglide/messages.js";
import { useFrontmatterSchema } from "../hooks/use-frontmatter-schema";

interface FrontmatterPanelProps {
  meta: EntryMeta | null;
  spacePath: string;
  projectPath?: string | null;
  filePath: string | null;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenPath?: (path: string, spaceId?: string | null) => void;
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
  onOpenPath,
  onPropertyChange,
}: FrontmatterPanelProps) {
  const { schemaResult, setSchemaResult } = useFrontmatterSchema(
    spacePath,
    filePath,
  );

  if (!meta) return null;

  const extraEntries = Object.entries(meta.extra ?? {});

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
                schemaResult={schemaResult}
                values={meta.extra ?? {}}
                onOpenPath={onOpenPath}
                onValueChange={onPropertyChange}
                onSchemaChange={setSchemaResult}
              />
            </div>
          ) : extraEntries.length > 0 ? (
            <details className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {m.editor_raw_yaml_toggle({
                  count: String(extraEntries.length),
                })}
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
