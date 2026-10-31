import { useCallback, useEffect, useRef, useState } from "react";
import {
  readGitConflictFile,
  resolveGitConflictFile,
  type GitConflictFile,
  type GitFileResolution,
  type GitPlaceChoice,
  type GitResolutionFinding,
} from "@/features/git";

/** Why the last resolution of the file did not resolve it. */
export type ConflictFileProblem =
  | { kind: "finding"; finding: GitResolutionFinding }
  | { kind: "failed"; message: string };

/**
 * A text file in conflict as "Changes" resolve it (1.F): its places, the
 * choices made in them so far — kept here and applied to the file at once
 * when every place has one — and the version of a side for the whole file.
 */
export function useConflictFile(spacePath: string, path: string) {
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<{
    key: string;
    file?: GitConflictFile;
    error?: boolean;
  } | null>(null);
  const [choices, setChoices] = useState<{
    version: string;
    choices: (GitPlaceChoice | null)[];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ConflictFileProblem | null>(null);
  const active = useRef(true);
  const key = `${spacePath}\0${path}\0${reload}`;

  useEffect(() => {
    active.current = true;
    let current = true;
    readGitConflictFile(spacePath, path).then(
      (file) => {
        if (current) setLoaded({ key, file });
      },
      () => {
        if (current) setLoaded({ key, error: true });
      },
    );
    return () => {
      current = false;
      active.current = false;
    };
  }, [key, path, spacePath]);

  const file = loaded?.key === key ? loaded.file : undefined;
  const places = file?.places?.type === "places" ? file.places.places : [];
  const chosen =
    file && choices?.version === file.version
      ? choices.choices
      : places.map(() => null);

  const resolve = useCallback(
    async (resolution: GitFileResolution) => {
      setPending(true);
      setProblem(null);
      try {
        const outcome = await resolveGitConflictFile(
          spacePath,
          path,
          resolution,
        );
        if (!active.current) return;
        if (outcome.type === "Unresolved") {
          setProblem({ kind: "finding", finding: outcome.finding });
          if (outcome.finding.type === "changed") setReload((n) => n + 1);
        } else if (outcome.type === "Failed") {
          setProblem({ kind: "failed", message: outcome.message });
        }
      } catch (error) {
        if (active.current)
          setProblem({ kind: "failed", message: String(error) });
      } finally {
        if (active.current) setPending(false);
      }
    },
    [path, spacePath],
  );

  const applyChoices = (next: (GitPlaceChoice | null)[]) => {
    if (!file) return;
    setChoices({ version: file.version, choices: next });
    if (next.length > 0 && next.every((choice) => choice !== null))
      void resolve({
        type: "places",
        version: file.version,
        choices: next as GitPlaceChoice[],
      });
  };

  return {
    file,
    loading: !loaded || loaded.key !== key,
    error: loaded?.key === key && !!loaded.error,
    retry: () => setReload((n) => n + 1),
    choices: chosen,
    pending,
    problem,
    /** The choice in one place; the last one applies them all. */
    choose: (index: number, choice: GitPlaceChoice) =>
      applyChoices(chosen.map((value, at) => (at === index ? choice : value))),
    /** «Оставить моё» or «Взять входящее» for every place without a choice. */
    chooseRemaining: (choice: GitPlaceChoice) =>
      applyChoices(chosen.map((value) => value ?? choice)),
    /** The version of a side before the merge for the whole file. */
    takeSide: (side: "ours" | "theirs") => resolve({ type: "side", side }),
  };
}
