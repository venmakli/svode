import { useCallback } from "react";
import type { CollectionSchema } from "@/features/properties";
import * as m from "@/paraglide/messages.js";
import { handleError } from "../../hooks/error-feedback";
import type { UseViewQueryResult } from "../model/types";

export function useSaveViewQuery({
  query,
  onSaved,
}: {
  query: UseViewQueryResult;
  onSaved?: (schema: CollectionSchema) => void;
}) {
  return useCallback(async () => {
    try {
      const schema = await query.saveForAll({
        confirmOverwrite: () =>
          window.confirm(m.view_query_confirm_save_changed()),
      });
      if (schema) onSaved?.(schema);
    } catch (error) {
      handleError(error);
    }
  }, [onSaved, query]);
}
