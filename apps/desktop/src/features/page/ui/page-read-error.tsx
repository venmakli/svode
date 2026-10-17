import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import * as m from "@/paraglide/messages.js";
import { usePageDetailContext } from "../hooks/page-detail-context";

/** A detail file that could not be read; the backend text is its detail. */
export function PageReadError({ openFile = false }: { openFile?: boolean }) {
  const context = usePageDetailContext();
  return (
    <Alert variant="destructive">
      <AlertTitle>
        {context.target === "page"
          ? m.page_detail_read_error_title()
          : m.scope_readme_error_title()}
      </AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <span>{context.error}</span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void context.reload()}>
            {m.identity_load_retry()}
          </Button>
          {openFile && context.target === "readme" ? (
            <Button
              variant="outline"
              onClick={() => context.onOpenPath(context.readmePath)}
            >
              {m.scope_readme_open_file()}
            </Button>
          ) : null}
        </div>
      </AlertDescription>
    </Alert>
  );
}
