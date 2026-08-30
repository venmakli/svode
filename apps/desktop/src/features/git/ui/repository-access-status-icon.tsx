import {
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
  LockKeyhole,
  TriangleAlert,
} from "lucide-react";

import type { repositoryAccessPresentation } from "./repository-access-copy";

export function RepositoryAccessStatusIcon({
  status,
  busy,
}: {
  status: ReturnType<typeof repositoryAccessPresentation>["status"];
  busy: boolean;
}) {
  const className = busy ? "animate-spin" : undefined;
  switch (status) {
    case "local":
    case "writable":
      return <CheckCircle2 data-icon="inline-start" className={className} />;
    case "checking":
    case "loading":
      return <LoaderCircle data-icon="inline-start" className={className} />;
    case "read_only":
      return <LockKeyhole data-icon="inline-start" className={className} />;
    case "error":
      return <TriangleAlert data-icon="inline-start" className={className} />;
    case "unknown":
      return <CircleHelp data-icon="inline-start" className={className} />;
  }
}
