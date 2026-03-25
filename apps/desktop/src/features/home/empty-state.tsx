import * as m from "@/paraglide/messages.js";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center text-center max-w-sm mx-auto">
      <p className="text-lg font-medium text-foreground">
        {m.home_empty_subtitle()}
      </p>
      <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
        {m.home_empty_description()}
      </p>
    </div>
  );
}
