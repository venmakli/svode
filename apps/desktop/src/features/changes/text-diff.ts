import { lazy } from "react";

/**
 * The diff of one file's text before and after a change made outside Git.
 * Loaded on first use, so surfaces that may show a diff do not load the
 * diff renderer up front.
 */
export const FileTextDiff = lazy(() =>
  import("./ui/text-diff").then((module) => ({ default: module.FileTextDiff })),
);
