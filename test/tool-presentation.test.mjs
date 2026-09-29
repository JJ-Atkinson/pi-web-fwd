import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultToolExpanded,
  toolWebPresentation,
  transitionToolStatus,
} from "../extensions/tool-presentation.ts";

test("read is collapsed and describes the requested file", () => {
  assert.deepEqual(
    toolWebPresentation("read", { path: "packages/client/lib/client.dart", offset: 20 }),
    {
      title: "Read · packages/client/lib/client.dart:20",
      expanded: false,
    },
  );
  assert.deepEqual(
    toolWebPresentation("read", { path: "README.md", offset: 5, limit: 10 }),
    { title: "Read · README.md:5-14", expanded: false },
  );
});

test("read without a path has a safe fallback", () => {
  assert.deepEqual(toolWebPresentation("read", {}), {
    title: "Read",
    expanded: false,
  });
});

test("other tools preserve their current title and expanded default", () => {
  assert.deepEqual(toolWebPresentation("bash", { command: "true" }), {
    title: "bash",
    expanded: true,
  });
});

test("write and edit summarize their file changes", () => {
  assert.deepEqual(
    toolWebPresentation("write", { path: "lib/new.dart", content: "one\ntwo\nthree" }),
    { title: "Write · lib/new.dart · 3 lines", expanded: true },
  );
  assert.deepEqual(
    toolWebPresentation("edit", {
      path: "lib/existing.dart",
      edits: [
        { oldText: "one", newText: "two" },
        { oldText: "three", newText: "four" },
      ],
    }),
    { title: "Edit · lib/existing.dart · 2 changes", expanded: true },
  );
});

test("apply_patch summarizes files and changed lines", () => {
  assert.deepEqual(
    toolWebPresentation("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: lib/a.dart",
        "@@",
        "-old",
        "+new",
        "*** Add File: lib/b.dart",
        "+first",
        "+second",
        "*** End Patch",
      ].join("\n"),
    }),
    { title: "Patch · 2 files · +3 −1", expanded: true },
  );
});

test("all tool output defaults collapsed on mobile", () => {
  assert.equal(defaultToolExpanded("bash", { command: "true" }, true), false);
  assert.equal(defaultToolExpanded("subagent", { calls: [] }, true), false);
  assert.equal(defaultToolExpanded("bash", { command: "true" }, false), true);
  assert.equal(defaultToolExpanded("read", { path: "README.md" }, false), false);
});

test("only running tools become interrupted", () => {
  assert.equal(transitionToolStatus("running", "interrupt"), "interrupted");
  assert.equal(transitionToolStatus("completed", "interrupt"), "completed");
  assert.equal(transitionToolStatus("interrupted", "complete"), "completed");
});
