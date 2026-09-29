export const REDACTED_THINKING = "(redacted thinking)";

function thinkingText(block: unknown): string {
  if (!block || typeof block !== "object") return "";
  const value = block as Record<string, unknown>;
  if (value.type !== "thinking") return "";
  if (typeof value.thinking === "string" && value.thinking) return value.thinking;
  return value.redacted === true ? REDACTED_THINKING : "";
}

export function thinkingBlocksFromMessage(
  message: unknown,
): Array<{ contentIndex: number; text: string }> {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const blocks: Array<{ contentIndex: number; text: string }> = [];
  for (let contentIndex = 0; contentIndex < content.length; contentIndex++) {
    const text = thinkingText(content[contentIndex]);
    if (text) blocks.push({ contentIndex, text });
  }
  return blocks;
}

export class ThinkingAccumulator {
  readonly #blocks = new Map<number, string>();
  readonly #order: number[] = [];

  clear(): void {
    this.#blocks.clear();
    this.#order.length = 0;
  }

  append(contentIndex: number, delta: string): void {
    this.#remember(contentIndex);
    this.#blocks.set(contentIndex, (this.#blocks.get(contentIndex) ?? "") + delta);
  }

  set(contentIndex: number, content: string): void {
    this.#remember(contentIndex);
    this.#blocks.set(contentIndex, content);
  }

  replaceFromMessage(message: unknown): void {
    this.clear();
    for (const block of thinkingBlocksFromMessage(message)) {
      this.set(block.contentIndex, block.text);
    }
  }

  text(): string {
    return this.#order
      .map((contentIndex) => this.#blocks.get(contentIndex) ?? "")
      .filter(Boolean)
      .join("\n\n");
  }

  #remember(contentIndex: number): void {
    if (!this.#blocks.has(contentIndex)) this.#order.push(contentIndex);
  }
}
