export type ToolWebPresentation = {
  title: string;
  expanded: boolean;
};

export type ToolRunStatus = "running" | "completed" | "interrupted";
export type ToolRunEvent = "complete" | "interrupt";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function compactPath(value: unknown): string {
  if (typeof value !== "string") return "";
  const path = value.replace(/\s+/g, " ").trim();
  return path.length > 180 ? `…${path.slice(-179)}` : path;
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value.length === 0) return 0;
  return value.split(/\r?\n/).length;
}

function patchSummary(value: unknown): { paths: string[]; added: number; removed: number } {
  if (typeof value !== "string") return { paths: [], added: 0, removed: 0 };
  const paths: string[] = [];
  let added = 0;
  let removed = 0;
  let inFile = false;
  for (const raw of value.replace(/\r\n?/g, "\n").split("\n")) {
    const header = raw.match(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/);
    if (header) {
      const path = compactPath(header[1]);
      if (path && !paths.includes(path)) paths.push(path);
      inFile = true;
      continue;
    }
    if (!inFile || raw.startsWith("*** ") || raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) added++;
    else if (raw.startsWith("-")) removed++;
  }
  return { paths, added, removed };
}

function countLabel(added: number, removed: number): string {
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`−${removed}`);
  return parts.join(" ");
}

export function toolWebPresentation(toolName: string, args: unknown): ToolWebPresentation {
  const input = record(args);
  const path = compactPath(input.path ?? input.file_path);
  if (toolName === "read") {
    const offset = typeof input.offset === "number" ? input.offset : 1;
    const range = typeof input.limit === "number"
      ? `:${offset}-${offset + input.limit - 1}`
      : input.offset !== undefined ? `:${offset}` : "";
    return {
      title: path ? `Read · ${path}${range}` : "Read",
      expanded: false,
    };
  }
  if (toolName === "write") {
    const lines = lineCount(input.content);
    return {
      title: `Write${path ? ` · ${path}` : ""}${lines ? ` · ${lines} lines` : ""}`,
      expanded: true,
    };
  }
  if (toolName === "edit") {
    const edits = Array.isArray(input.edits)
      ? input.edits.length
      : typeof input.oldText === "string" && typeof input.newText === "string" ? 1 : 0;
    return {
      title: `Edit${path ? ` · ${path}` : ""}${edits ? ` · ${edits} ${edits === 1 ? "change" : "changes"}` : ""}`,
      expanded: true,
    };
  }
  if (toolName === "apply_patch") {
    const patch = patchSummary(input.patch);
    const target = patch.paths.length === 1
      ? patch.paths[0]
      : patch.paths.length > 1 ? `${patch.paths.length} files` : "";
    const counts = countLabel(patch.added, patch.removed);
    return {
      title: `Patch${target ? ` · ${target}` : ""}${counts ? ` · ${counts}` : ""}`,
      expanded: true,
    };
  }
  return { title: toolName, expanded: true };
}

export function defaultToolExpanded(toolName: string, args: unknown, mobile: boolean): boolean {
  return toolWebPresentation(toolName, args).expanded && !mobile;
}

export function transitionToolStatus(
  status: ToolRunStatus,
  event: ToolRunEvent,
): ToolRunStatus {
  if (event === "complete") return "completed";
  return status === "running" ? "interrupted" : status;
}
