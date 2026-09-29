const SEMANTIC_COMPONENTS = new Set([
  "Spacer",
  "UserMessageComponent",
  "AssistantMessageComponent",
  "ToolExecutionComponent",
]);

export function needsTranscriptFallback(componentName: string): boolean {
  return Boolean(componentName) && !SEMANTIC_COMPONENTS.has(componentName);
}

export function hasSpecializedPiToolPresentation(
  toolName: string,
  plainLines: string[],
): boolean {
  if (toolName !== "read") return false;
  const first = plainLines.find((line) => line.trim())?.trim() ?? "";
  return first.startsWith("[skill] ") ||
    first.startsWith("read docs ") ||
    first.startsWith("read resource ");
}

export function transcriptFallbackTitle(componentName: string): string {
  const label = componentName
    .replace(/Component$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim();
  return label || "Pi transcript";
}

export function boundTranscriptLines(
  lines: string[],
  maxLines = 1_000,
  maxChars = 400_000,
): { lines: string[]; omitted: number } {
  const output: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (output.length >= maxLines || chars + line.length > maxChars) break;
    output.push(line);
    chars += line.length;
  }
  return { lines: output, omitted: Math.max(0, lines.length - output.length) };
}
