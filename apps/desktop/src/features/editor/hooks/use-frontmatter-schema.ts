import { useEffect, useState } from "react";

import { getEntrySchema } from "@/features/properties/api";
import type { EntrySchemaResult } from "@/features/properties";

export function useFrontmatterSchema(
  spacePath: string,
  filePath: string | null,
): {
  schemaResult: EntrySchemaResult | null;
  setSchemaResult: (result: EntrySchemaResult | null) => void;
} {
  const [schemaResult, setSchemaResult] = useState<EntrySchemaResult | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    if (!spacePath || !filePath) {
      queueMicrotask(() => {
        if (!cancelled) setSchemaResult(null);
      });
      return () => {
        cancelled = true;
      };
    }

    getEntrySchema({ spacePath, filePath })
      .then((result) => {
        if (!cancelled) setSchemaResult(result);
      })
      .catch(() => {
        if (!cancelled) setSchemaResult(null);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath, spacePath]);

  return { schemaResult, setSchemaResult };
}
