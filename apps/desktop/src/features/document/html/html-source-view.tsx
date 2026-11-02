import { useMemo } from "react";
import { File as SourceFile } from "@pierre/diffs/react";

import { useTheme } from "@/components/ui/theme-provider";

/** The text of the file, read-only, with highlighting and line numbers. */
export function HtmlSourceView({
  path,
  text,
  version,
}: {
  path: string;
  text: string;
  /** The generation of the file: the component reads a file once. */
  version: string;
}) {
  const { theme } = useTheme();
  const file = useMemo(
    () => ({ name: path, contents: text, cacheKey: `${path}:${version}` }),
    [path, text, version],
  );
  const options = useMemo(
    () => ({
      themeType: theme,
      overflow: "wrap" as const,
      disableFileHeader: true,
    }),
    [theme],
  );
  return (
    <div className="size-full overflow-auto" data-html-document="source">
      <SourceFile key={file.cacheKey} file={file} options={options} />
    </div>
  );
}
