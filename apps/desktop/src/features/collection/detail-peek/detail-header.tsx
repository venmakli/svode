import type { ReactNode } from "react";

/**
 * The read-only header of a fixed Collection item below the peek top bar, in
 * the view of the page header: icon, name and a short description from the
 * item's source.
 */
export function CollectionDetailHeader({
  description,
  icon,
  title,
}: {
  description?: string | null;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div
      className="flex min-w-0 items-start gap-3"
      data-collection-detail-header
    >
      <span
        className="flex size-9 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-6"
        aria-hidden
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <p className="min-w-0 break-words text-[22px] font-bold leading-8 [overflow-wrap:anywhere]">
          {title}
        </p>
        {description ? (
          <p className="min-w-0 whitespace-pre-wrap break-words text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
