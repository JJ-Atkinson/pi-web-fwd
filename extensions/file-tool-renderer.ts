export type FileToolRowKind = "add" | "remove" | "context" | "meta" | "error";

export type FileToolRow = {
  kind: FileToolRowKind;
  marker?: string;
  line?: string;
  text: string;
};

export type FileToolBody = {
  rows: FileToolRow[];
  hiddenRows: number;
};

const COLLAPSED_ROWS = 8;
const EXPANDED_ROWS = 1_000;
const MAX_LINE_CHARS = 1_000;

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function clipLine(value: string): string {
  return value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS - 1)}…` : value;
}

function resultText(result: unknown): string {
  const content = rec(result).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text")
    .map((part) => String((part as Record<string, unknown>).text ?? ""))
    .join("\n");
}

function hasImage(result: unknown): boolean {
  const content = rec(result).content;
  return Array.isArray(content) &&
    content.some((part) => part && typeof part === "object" &&
      (part as Record<string, unknown>).type === "image");
}

function numberedRows(text: string, start: number): FileToolRow[] {
  return text.split(/\r?\n/).map((line, index) => ({
    kind: "context",
    line: String(start + index),
    text: clipLine(line),
  }));
}

function editRows(args: unknown, result: unknown): FileToolRow[] {
  const diff = rec(rec(result).details).diff;
  if (typeof diff === "string" && diff) {
    return diff.split(/\r?\n/).map((line) => {
      const match = line.match(/^([+\- ])\s*(\d+)\s(.*)$/);
      if (!match) return { kind: "meta", text: clipLine(line) };
      return {
        kind: match[1] === "+" ? "add" : match[1] === "-" ? "remove" : "context",
        marker: match[1],
        line: match[2],
        text: clipLine(match[3]),
      };
    });
  }
  const input = rec(args);
  const edits = Array.isArray(input.edits)
    ? input.edits
    : typeof input.oldText === "string" && typeof input.newText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }]
      : [];
  const rows: FileToolRow[] = [];
  for (const [index, value] of edits.entries()) {
    const edit = rec(value);
    if (edits.length > 1) rows.push({ kind: "meta", text: `Change ${index + 1}` });
    for (const line of String(edit.oldText ?? "").split(/\r?\n/)) {
      rows.push({ kind: "remove", marker: "-", text: clipLine(line) });
    }
    for (const line of String(edit.newText ?? "").split(/\r?\n/)) {
      rows.push({ kind: "add", marker: "+", text: clipLine(line) });
    }
  }
  return rows;
}

function patchRows(args: unknown): FileToolRow[] {
  const patch = rec(args).patch;
  if (typeof patch !== "string") return [];
  const rows: FileToolRow[] = [];
  for (const raw of patch.replace(/\r\n?/g, "\n").split("\n")) {
    if (raw === "*** Begin Patch" || raw === "*** End Patch" || raw === "*** End of File") continue;
    const file = raw.match(/^\*\*\* (Add|Update|Delete) File:\s*(.+)$/);
    if (file) {
      rows.push({ kind: "meta", marker: file[1][0], text: clipLine(file[2].trim()) });
      continue;
    }
    const move = raw.match(/^\*\*\* Move to:\s*(.+)$/);
    if (move) {
      rows.push({ kind: "meta", marker: "→", text: clipLine(move[1].trim()) });
      continue;
    }
    if (raw === "@@" || raw.startsWith("@@ ")) {
      rows.push({ kind: "meta", text: clipLine(raw) });
      continue;
    }
    if (raw.startsWith("+")) rows.push({ kind: "add", marker: "+", text: clipLine(raw.slice(1)) });
    else if (raw.startsWith("-")) rows.push({ kind: "remove", marker: "-", text: clipLine(raw.slice(1)) });
    else if (raw.startsWith(" ")) rows.push({ kind: "context", marker: " ", text: clipLine(raw.slice(1)) });
  }
  return rows;
}

function bounded(rows: FileToolRow[], expanded: boolean): FileToolBody {
  const limit = expanded ? EXPANDED_ROWS : COLLAPSED_ROWS;
  return {
    rows: rows.slice(0, limit),
    hiddenRows: Math.max(0, rows.length - limit),
  };
}

export function fileToolBody(
  toolName: string,
  args: unknown,
  result: unknown,
  isError: boolean,
  expanded: boolean,
): FileToolBody | undefined {
  if (!["read", "write", "edit", "apply_patch"].includes(toolName)) return undefined;
  if (toolName === "read" && hasImage(result)) return undefined;
  if (isError) {
    const text = resultText(result) || "Tool execution failed.";
    return bounded(text.split(/\r?\n/).map((line) => ({
      kind: "error" as const,
      text: clipLine(line),
    })), expanded);
  }
  if (toolName === "read") {
    const text = resultText(result);
    if (!text) return bounded([{ kind: "meta", text: "Waiting for file content…" }], expanded);
    const offset = typeof rec(args).offset === "number" ? Number(rec(args).offset) : 1;
    return bounded(numberedRows(text, offset), expanded);
  }
  if (toolName === "write") {
    const content = rec(args).content;
    const text = typeof content === "string" ? content : "";
    return bounded(numberedRows(text, 1), expanded);
  }
  if (toolName === "edit") return bounded(editRows(args, result), expanded);
  return bounded(patchRows(args), expanded);
}
