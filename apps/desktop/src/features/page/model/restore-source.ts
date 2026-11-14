import type { PageMeta } from "./types";

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * The Markdown source of a Page whose file is written again at its path:
 * the frontmatter of `meta` and `body` below it. Values are written in the
 * JSON form YAML reads as the same values; the dates the file system and
 * Git give a Page are not fields of its file.
 */
export function pageRestoreSource(meta: PageMeta, body: string): string {
  const fields: [string, unknown][] = [["title", meta.title]];
  if (meta.icon) fields.push(["icon", meta.icon]);
  if (meta.description) fields.push(["description", meta.description]);
  if (meta.cover) fields.push(["cover", meta.cover]);
  for (const [key, value] of Object.entries(meta.extra))
    if (value !== undefined) fields.push([key, value]);
  const lines = fields.map(
    ([key, value]) =>
      `${PLAIN_KEY.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}`,
  );
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
