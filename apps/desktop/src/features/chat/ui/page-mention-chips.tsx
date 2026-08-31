import { FileText, XIcon } from "lucide-react";
import { useChatStatusStore } from "../model";
import { useOpenPage } from "@/features/page/navigation";

interface PageMentionChipsProps {
  onRemoveText?: (title: string) => void;
}

export function PageMentionChips({ onRemoveText }: PageMentionChipsProps) {
  const pageMentions = useChatStatusStore((s) => s.pageMentions);
  const removePageMention = useChatStatusStore((s) => s.removePageMention);
  const openPage = useOpenPage();

  if (pageMentions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1">
      {pageMentions.map((page) => (
        <span
          key={page.path}
          className="inline-flex items-center gap-1 rounded-md bg-accent pl-1.5 pr-0.5 py-0.5 text-accent-foreground text-xs font-medium"
        >
          <button
            type="button"
            className="inline-flex items-center gap-1 cursor-pointer hover:underline"
            onClick={() => openPage(page.path)}
            title={page.path}
          >
            {page.icon ? (
              <span className="text-xs">{page.icon}</span>
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate max-w-[150px]">{page.title}</span>
          </button>
          <button
            type="button"
            className="ml-0.5 rounded-sm p-0.5 hover:bg-accent-foreground/10 transition-colors"
            onClick={() => {
              onRemoveText?.(page.title);
              removePageMention(page.path);
            }}
            aria-label={`Remove ${page.title}`}
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
