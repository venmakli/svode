import { useCallback, useState } from "react";
import { invokeCommand as invoke } from "@/platform/native/invoke";
import { ApprovalCard } from "@/components/tool-ui/approval-card";
import { QuestionFlow } from "@/components/tool-ui/question-flow";
import { Button } from "@/components/ui/button";
import { useChatStatusStore } from "../model";
import type { ApprovalDecision, MetadataItem } from "@/components/tool-ui/approval-card";
import type { QuestionFlowOption } from "@/components/tool-ui/question-flow";

// Map tool names to human-readable descriptions and lucide icon names
const TOOL_INFO: Record<
  string,
  { label: string; icon: string; variant?: "default" | "destructive" }
> = {
  Edit: { label: "Edit file", icon: "pencil" },
  Write: { label: "Write file", icon: "file-plus" },
  Bash: { label: "Run command", icon: "terminal", variant: "destructive" },
  Read: { label: "Read file", icon: "file-text" },
  Glob: { label: "Search files", icon: "search" },
  Grep: { label: "Search content", icon: "search" },
  WebFetch: { label: "Fetch URL", icon: "globe" },
  WebSearch: { label: "Web search", icon: "globe" },
  NotebookEdit: { label: "Edit notebook", icon: "notebook-pen" },
};

function getToolMetadata(
  toolName: string,
  input: Record<string, unknown>,
): MetadataItem[] {
  const metadata: MetadataItem[] = [];

  if (toolName === "Edit") {
    if (input.file_path)
      metadata.push({ key: "File", value: String(input.file_path) });
    if (input.old_string)
      metadata.push({
        key: "Replace",
        value:
          String(input.old_string).slice(0, 100) +
          (String(input.old_string).length > 100 ? "\u2026" : ""),
      });
    if (input.new_string)
      metadata.push({
        key: "With",
        value:
          String(input.new_string).slice(0, 100) +
          (String(input.new_string).length > 100 ? "\u2026" : ""),
      });
  } else if (toolName === "Write") {
    if (input.file_path)
      metadata.push({ key: "File", value: String(input.file_path) });
  } else if (toolName === "Bash") {
    if (input.command)
      metadata.push({ key: "Command", value: String(input.command) });
  } else if (toolName === "Read") {
    if (input.file_path)
      metadata.push({ key: "File", value: String(input.file_path) });
  } else {
    // Generic: show all input keys
    for (const [key, value] of Object.entries(input)) {
      if (typeof value === "string") {
        metadata.push({
          key,
          value: value.slice(0, 120) + (value.length > 120 ? "\u2026" : ""),
        });
      }
    }
  }

  return metadata;
}

export function PermissionCard() {
  const pendingPermission = useChatStatusStore((s) => s.pendingPermission);
  const [choice, setChoice] = useState<ApprovalDecision | undefined>();
  const [userAnswer, setUserAnswer] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleRespond = useCallback(
    async (behavior: "allow" | "deny", message?: string) => {
      if (!pendingPermission || isSubmitting) return;
      setIsSubmitting(true);

      // Build updatedInput based on tool type
      let updatedInput: Record<string, unknown> | null = null;
      if (behavior === "allow") {
        if (pendingPermission.toolName === "AskUserQuestion") {
          // For AskUserQuestion: pass back questions + answers map
          const questions = (pendingPermission.input.questions as Array<{ question: string }>) ?? [];
          const answers: Record<string, string> = {};
          if (questions.length > 0) {
            // First question gets the user's answer/selection
            answers[questions[0].question] = message ?? "";
          }
          updatedInput = {
            ...pendingPermission.input,
            answers,
          };
        } else {
          // For regular tools: pass back original input
          updatedInput = pendingPermission.input;
        }
      }

      try {
        await invoke("agent_respond_permission", {
          sessionId: pendingPermission.sessionId,
          requestId: pendingPermission.requestId,
          behavior,
          updatedInput,
          message: message ?? null,
        });

        setChoice(behavior === "allow" ? "approved" : "denied");

        // Clear pending permission after a brief delay for receipt animation
        setTimeout(() => {
          useChatStatusStore.getState().setPendingPermission(null);
          useChatStatusStore.getState().setAgentStatus("thinking");
          setChoice(undefined);
          setUserAnswer("");
          setIsSubmitting(false);
        }, 800);
      } catch (err) {
        console.error("Failed to respond to permission:", err);
        setIsSubmitting(false);
      }
    },
    [pendingPermission, isSubmitting],
  );

  if (!pendingPermission) return null;

  const { toolName, input, requestId } = pendingPermission;

  // AskUserQuestion — structured questions with options (QuestionFlow) or free-text fallback
  if (toolName === "AskUserQuestion") {
    const questions = input.questions as Array<{
      question: string;
      header?: string;
      options?: Array<{ label: string; description?: string }>;
      multiSelect?: boolean;
    }> | undefined;

    const hasStructuredQuestions = questions && questions.length > 0 && questions[0].options && questions[0].options.length > 0;

    // Structured questions with options → use QuestionFlow
    if (hasStructuredQuestions) {
      const q = questions[0];
      const options: QuestionFlowOption[] = q.options!.map((opt, i) => ({
        id: String(i),
        label: opt.label,
        description: opt.description,
      }));

      return (
        <div className="mx-auto w-full max-w-[44rem] px-2 pb-3">
          <QuestionFlow
            id={requestId}
            step={1}
            title={q.question}
            description={q.header}
            options={options}
            selectionMode={q.multiSelect ? "multi" : "single"}
            onSelect={(selectedIds) => {
              // Map selected IDs back to labels
              const selectedLabels = selectedIds
                .map((id) => q.options![Number(id)]?.label)
                .filter(Boolean);
              const answer = selectedLabels.join(", ");
              handleRespond("allow", answer);
            }}
          />
        </div>
      );
    }

    // Free-text fallback (no structured options)
    const questionText =
      questions?.[0]?.question ??
      (input.question as string) ??
      (input.message as string) ??
      "The agent has a question for you";

    return (
      <div className="mx-auto w-full max-w-[44rem] px-2 pb-3">
        <article className="flex w-full flex-col gap-3 text-foreground">
          <div className="bg-card flex w-full flex-col gap-4 rounded-2xl border p-5 shadow-xs">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold leading-tight">
                Agent Question
              </h2>
              <p className="text-sm text-muted-foreground">{questionText}</p>
            </div>
            <textarea
              value={userAnswer}
              onChange={(e) => setUserAnswer(e.target.value)}
              placeholder="Type your answer..."
              className="min-h-20 w-full resize-none rounded-lg border bg-background px-3 py-2 text-sm outline-none transition-shadow placeholder:text-muted-foreground/80 focus:border-ring/75 focus:ring-2 focus:ring-ring/20"
              rows={3}
              autoFocus
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.metaKey || e.ctrlKey) &&
                  userAnswer.trim()
                ) {
                  handleRespond("allow", userAnswer.trim());
                }
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              className="rounded-full"
              onClick={() => handleRespond("deny")}
              disabled={isSubmitting}
            >
              Skip
            </Button>
            <Button
              className="rounded-full"
              onClick={() =>
                handleRespond("allow", userAnswer.trim() || undefined)
              }
              disabled={isSubmitting || !userAnswer.trim()}
            >
              Send
            </Button>
          </div>
        </article>
      </div>
    );
  }

  // Regular tool permission — use ApprovalCard
  const info = TOOL_INFO[toolName] ?? { label: toolName, icon: "wrench" };
  const metadata = getToolMetadata(toolName, input);

  return (
    <div className="mx-auto w-full max-w-[44rem] px-2 pb-3">
      <ApprovalCard
        id={requestId}
        title={`Allow ${info.label}?`}
        description={`The agent wants to use ${toolName}`}
        icon={info.icon}
        metadata={metadata}
        variant={info.variant ?? "default"}
        confirmLabel="Allow"
        cancelLabel="Deny"
        choice={choice}
        onConfirm={() => handleRespond("allow")}
        onCancel={() => handleRespond("deny")}
      />
    </div>
  );
}
