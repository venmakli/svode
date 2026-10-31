import { useMemo } from "react";
import { UnresolvedFile } from "@pierre/diffs/react";
import { useTheme } from "@/components/ui/theme-provider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GitConflictPlace, GitPlaceChoice } from "@/features/git";
import * as m from "@/paraglide/messages.js";
import { conflictDisplayText } from "../lib/conflict-display";

/**
 * The places of a text file in conflict in `UnresolvedFile`, with «Моё»,
 * «Входящее» and «Оба» at each. The places are Svode's (DF-238); the
 * component only shows them and holds the action slot of each.
 */
export function ConflictPlaces({
  path,
  version,
  content,
  places,
  choices,
  disabled,
  onChoose,
}: {
  path: string;
  version: string;
  content: string;
  places: readonly GitConflictPlace[];
  choices: readonly (GitPlaceChoice | null)[];
  disabled: boolean;
  onChoose: (index: number, choice: GitPlaceChoice) => void;
}) {
  const { theme } = useTheme();
  const file = useMemo(
    () => ({
      name: path,
      contents: conflictDisplayText(content, places, {
        ours: m.changes_conflict_ours(),
        theirs: m.changes_conflict_theirs(),
      }),
      cacheKey: `${path}:${version}`,
    }),
    [content, path, places, version],
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
    <UnresolvedFile
      // The component reads its file once; a new version is a new file.
      key={file.cacheKey}
      file={file}
      options={options}
      renderMergeConflictUtility={(action) => (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          className="bg-background"
          aria-label={m.changes_conflict_place({
            index: String(action.conflictIndex + 1),
          })}
          value={choices[action.conflictIndex] ?? ""}
          disabled={disabled}
          onValueChange={(value) => {
            if (value) onChoose(action.conflictIndex, value as GitPlaceChoice);
          }}
          data-conflict-place={action.conflictIndex}
        >
          <ToggleGroupItem value="ours">
            {m.changes_conflict_ours()}
          </ToggleGroupItem>
          <ToggleGroupItem value="theirs">
            {m.changes_conflict_theirs()}
          </ToggleGroupItem>
          <ToggleGroupItem value="both">
            {m.changes_conflict_both()}
          </ToggleGroupItem>
        </ToggleGroup>
      )}
    />
  );
}
