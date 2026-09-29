import assert from "node:assert/strict";
import test from "node:test";
import {
  boundTranscriptLines,
  hasSpecializedPiToolPresentation,
  needsTranscriptFallback,
  transcriptFallbackTitle,
} from "../extensions/transcript-fallback.ts";

test("semantic transcript components do not duplicate browser cards", () => {
  assert.equal(needsTranscriptFallback("Spacer"), false);
  assert.equal(needsTranscriptFallback("UserMessageComponent"), false);
  assert.equal(needsTranscriptFallback("AssistantMessageComponent"), false);
  assert.equal(needsTranscriptFallback("ToolExecutionComponent"), false);
});

test("unknown and specialized transcript components fail open", () => {
  assert.equal(needsTranscriptFallback("SkillInvocationMessageComponent"), true);
  assert.equal(needsTranscriptFallback("FuturePiComponent"), true);
  assert.equal(transcriptFallbackTitle("SkillInvocationMessageComponent"), "Skill Invocation Message");
});

test("specialized read presentations retain Pi rendering", () => {
  assert.equal(hasSpecializedPiToolPresentation("read", ["[skill] product-docs"]), true);
  assert.equal(hasSpecializedPiToolPresentation("read", ["read docs docs/tui.md"]), true);
  assert.equal(hasSpecializedPiToolPresentation("read", ["read resource AGENTS.md"]), true);
  assert.equal(hasSpecializedPiToolPresentation("read", ["read lib/main.dart"]), false);
  assert.equal(hasSpecializedPiToolPresentation("write", ["[skill] product-docs"]), false);
});

test("fallback output is bounded", () => {
  assert.deepEqual(boundTranscriptLines(["one", "two", "three"], 2, 100), {
    lines: ["one", "two"],
    omitted: 1,
  });
});
