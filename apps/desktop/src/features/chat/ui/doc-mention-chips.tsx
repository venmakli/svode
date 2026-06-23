import { FileText, XIcon } from "lucide-react";
import { useChatStatusStore } from "../model";
import { useEntrySelectionStore } from "@/features/entry/selection";

interface DocMentionChipsProps {
  onRemoveText?: (title: string) => void;
}

export function DocMentionChips({ onRemoveText }: DocMentionChipsProps) {
  const docMentions = useChatStatusStore((s) => s.docMentions);
  const removeDocMention = useChatStatusStore((s) => s.removeDocMention);
  const openDocument = useEntrySelectionStore((s) => s.openDocument);

  if (docMentions.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 px-1">
      {docMentions.map((doc) => (
        <span
          key={doc.path}
          className="inline-flex items-center gap-1 rounded-md bg-accent pl-1.5 pr-0.5 py-0.5 text-accent-foreground text-xs font-medium"
        >
          <button
            type="button"
            className="inline-flex items-center gap-1 cursor-pointer hover:underline"
            onClick={() => openDocument(doc.path)}
            title={doc.path}
          >
            {doc.icon ? (
              <span className="text-xs">{doc.icon}</span>
            ) : (
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate max-w-[150px]">{doc.title}</span>
          </button>
          <button
            type="button"
            className="ml-0.5 rounded-sm p-0.5 hover:bg-accent-foreground/10 transition-colors"
            onClick={() => {
              onRemoveText?.(doc.title);
              removeDocMention(doc.path);
            }}
            aria-label={`Remove ${doc.title}`}
          >
            <XIcon className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
