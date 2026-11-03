export { ChangesControl, ChangesWindow } from "./ui/changes-control";
export { fileChangesTarget, type ChangesTarget } from "./model/scope";
export { commitSessionArea } from "./api/session-commit";
export { useConflictFile } from "./hooks/use-conflict-file";
export {
  ProblemAlert as ConflictProblemAlert,
  WholeFileAction as ConflictWholeFileAction,
} from "./ui/conflicted-item";
