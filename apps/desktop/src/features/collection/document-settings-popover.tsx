import { Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { MultiPanePopover } from "@/features/collection/query";
import { cn } from "@/lib/utils";
import * as m from "@/paraglide/messages.js";

export function DocumentSettings({
  open,
  label,
  onOpenChange,
  onLabelChange,
  onSave,
}: {
  open: boolean;
  label: string;
  onOpenChange: (open: boolean) => void;
  onLabelChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <MultiPanePopover
      open={open}
      onOpenChange={onOpenChange}
      mainPane="main"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn(open && "bg-accent text-accent-foreground")}
        >
          <Settings />
          <span className="sr-only">{m.collection_document_tab()}</span>
        </Button>
      }
      panes={[
        {
          id: "main",
          title: m.collection_document_tab(),
          content: (
            <div className="flex flex-col">
              <div className="p-2">
                <Input
                  autoFocus
                  value={label}
                  onChange={(event) => onLabelChange(event.target.value)}
                  onBlur={onSave}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onSave();
                      onOpenChange(false);
                    }
                    if (event.key === "Escape") onOpenChange(false);
                  }}
                  className="h-10 border-0 bg-muted px-3 text-sm font-semibold shadow-none focus-visible:ring-0"
                />
              </div>
              <div className="px-3 pb-3 pt-2 text-xs font-medium uppercase text-muted-foreground">
                {m.collection_document_tab_section()}
              </div>
              <Separator />
              <div className="px-3 py-3 text-xs leading-relaxed text-muted-foreground">
                {m.collection_document_tab_description()}
              </div>
            </div>
          ),
        },
      ]}
    />
  );
}
