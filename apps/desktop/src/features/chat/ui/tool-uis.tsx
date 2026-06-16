import { makeAssistantToolUI } from "@assistant-ui/react";
import { Terminal } from "@/components/tool-ui/terminal";
import { CodeDiff } from "@/components/tool-ui/code-diff";
import { Plan } from "@/components/tool-ui/plan";

let toolUiCounter = 0;
function uniqueId(prefix: string): string {
  return `${prefix}-${++toolUiCounter}`;
}

function langFromFilename(filename?: string): string {
  if (!filename) return "text";
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    rs: "rust",
    py: "python",
    go: "go",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    xml: "xml",
    svg: "xml",
    vue: "vue",
    svelte: "svelte",
    graphql: "graphql",
    dockerfile: "dockerfile",
  };
  return map[ext ?? ""] ?? "text";
}

export const BashToolUI = makeAssistantToolUI<{ command?: string }, unknown>({
  toolName: "Bash",
  render: ({ args, result, status }) => {
    const command = args.command ?? "";
    if (!command && status.type === "running") return null;

    const resultStr =
      result != null && result !== "Done" && typeof result === "string"
        ? result
        : undefined;

    return (
      <Terminal
        id={uniqueId("bash")}
        command={command}
        stdout={resultStr}
        exitCode={0}
        maxCollapsedLines={15}
      />
    );
  },
});

export const EditToolUI = makeAssistantToolUI<
  { file_path?: string; old_string?: string; new_string?: string },
  unknown
>({
  toolName: "Edit",
  render: ({ args, status }) => {
    const filePath = args.file_path;
    const oldCode = args.old_string ?? "";
    const newCode = args.new_string ?? "";
    if (!filePath && status.type === "running") return null;

    const filename = filePath?.split("/").pop();
    return (
      <CodeDiff
        id={uniqueId("edit")}
        oldCode={oldCode}
        newCode={newCode}
        language={langFromFilename(filename)}
        filename={filename}
        lineNumbers="visible"
        diffStyle="unified"
        maxCollapsedLines={25}
      />
    );
  },
});

export const WriteToolUI = makeAssistantToolUI<
  { file_path?: string; content?: string },
  unknown
>({
  toolName: "Write",
  render: ({ args, status }) => {
    const filePath = args.file_path;
    const content = args.content ?? "";
    if (!filePath && status.type === "running") return null;

    const filename = filePath?.split("/").pop();
    return (
      <CodeDiff
        id={uniqueId("write")}
        oldCode=""
        newCode={content}
        language={langFromFilename(filename)}
        filename={filename}
        lineNumbers="visible"
        diffStyle="unified"
        maxCollapsedLines={25}
      />
    );
  },
});

export const PlanToolUI = makeAssistantToolUI<
  {
    title?: string;
    description?: string;
    todos?: Array<{
      id: string;
      label: string;
      status: string;
      description?: string;
    }>;
  },
  unknown
>({
  toolName: "Plan",
  render: ({ args, status }) => {
    const title = args.title ?? "Plan";
    const todos = args.todos ?? [];
    if (todos.length === 0 && status.type === "running") return null;

    return (
      <Plan
        id={uniqueId("plan")}
        title={title}
        description={args.description}
        todos={todos.map((t) => ({
          id: t.id,
          label: t.label,
          status:
            (t.status as
              | "pending"
              | "in_progress"
              | "completed"
              | "cancelled") ?? "pending",
          description: t.description,
        }))}
      />
    );
  },
});
