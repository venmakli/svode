import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { detailPageViewClassName } from "@/shared/ui/page-layout";
import * as m from "@/paraglide/messages.js";

// The area of a view this version cannot show: a newer Svode version created
// it or set what its filter, sort or layout depends on.
export function NewerViewNotice() {
  return (
    <div className={detailPageViewClassName} data-newer-view>
      <Alert>
        <TriangleAlert />
        <AlertTitle>{m.collection_view_newer_title()}</AlertTitle>
        <AlertDescription>
          {m.collection_view_newer_description()}
        </AlertDescription>
      </Alert>
    </div>
  );
}
