import assert from "node:assert/strict";
import test from "node:test";
import {
  REDACTED_THINKING,
  ThinkingAccumulator,
  thinkingBlocksFromMessage,
} from "../extensions/thinking.ts";

test("thinking blocks are extracted in assistant content order", () => {
  assert.deepEqual(
    thinkingBlocksFromMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "first" },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "second" },
        { type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" },
      ],
    }),
    [
      { contentIndex: 0, text: "first" },
      { contentIndex: 2, text: "second" },
      { contentIndex: 3, text: REDACTED_THINKING },
    ],
  );
});

test("one accumulator combines sequential blocks without duplicating final content", () => {
  const thinking = new ThinkingAccumulator();
  thinking.append(0, "first ");
  thinking.append(0, "draft");
  thinking.append(2, "second draft");
  assert.equal(thinking.text(), "first draft\n\nsecond draft");

  thinking.set(0, "first final");
  thinking.set(2, "second final");
  assert.equal(thinking.text(), "first final\n\nsecond final");
});

test("authoritative message content replaces streamed thinking", () => {
  const thinking = new ThinkingAccumulator();
  thinking.append(0, "stale");
  thinking.replaceFromMessage({
    content: [
      { type: "thinking", thinking: "authoritative one" },
      { type: "text", text: "answer" },
      { type: "thinking", thinking: "authoritative two" },
    ],
  });
  assert.equal(thinking.text(), "authoritative one\n\nauthoritative two");
});
