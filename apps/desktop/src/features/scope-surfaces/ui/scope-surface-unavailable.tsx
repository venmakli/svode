import {
  Empty,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";
import * as m from "@/paraglide/messages.js";

export function ScopeSurfaceUnavailable() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyDescription>{m.scope_surface_unavailable()}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
