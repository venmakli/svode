import * as m from "@/paraglide/messages.js";

export function EmptyState() {
  return (
    <div className="text-center max-w-sm mx-auto">
      <p className="text-sm text-muted-foreground leading-relaxed">
        {m.home_empty_description()}
      </p>
    </div>
  );
}
