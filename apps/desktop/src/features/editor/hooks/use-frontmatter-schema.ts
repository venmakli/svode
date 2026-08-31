import { useEffect, useState } from "react";

import { getPageSchema } from "@/features/properties/api";
import type { PageSchemaResult } from "@/features/properties";

export function useFrontmatterSchema(
  spacePath: string,
  filePath: string | null,
): {
  schemaResult: PageSchemaResult | null;
  setSchemaResult: (result: PageSchemaResult | null) => void;
} {
  const [schemaResult, setSchemaResult] = useState<PageSchemaResult | null>(
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

    getPageSchema({ spacePath, filePath })
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
