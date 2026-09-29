import assert from "node:assert/strict";
import test from "node:test";
import { fileToolBody } from "../extensions/file-tool-renderer.ts";

test("read body has line numbers and bounded collapsed content", () => {
  const body = fileToolBody(
    "read",
    { path: "a.dart", offset: 20 },
    { content: [{ type: "text", text: Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n") }] },
    false,
    false,
  );
  assert.equal(body.rows.length, 8);
  assert.equal(body.rows[0].line, "20");
  assert.equal(body.rows[0].text, "line 0");
  assert.equal(body.hiddenRows, 4);
});

test("write body expands to the supplied content", () => {
  assert.deepEqual(
    fileToolBody("write", { content: "one\ntwo" }, undefined, false, true),
    {
      rows: [
        { kind: "context", line: "1", text: "one" },
        { kind: "context", line: "2", text: "two" },
      ],
      hiddenRows: 0,
    },
  );
});

test("edit body uses authoritative diff details", () => {
  const body = fileToolBody(
    "edit",
    {},
    { details: { diff: "-10 old\n+10 new\n 11 context" } },
    false,
    true,
  );
  assert.deepEqual(body.rows, [
    { kind: "remove", marker: "-", line: "10", text: "old" },
    { kind: "add", marker: "+", line: "10", text: "new" },
    { kind: "context", marker: " ", line: "11", text: "context" },
  ]);
});

test("apply_patch body groups file headers and diff lines", () => {
  const body = fileToolBody(
    "apply_patch",
    {
      patch: [
        "*** Begin Patch",
        "*** Update File: lib/a.dart",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    },
    undefined,
    false,
    true,
  );
  assert.deepEqual(body.rows, [
    { kind: "meta", marker: "U", text: "lib/a.dart" },
    { kind: "meta", text: "@@" },
    { kind: "remove", marker: "-", text: "old" },
    { kind: "add", marker: "+", text: "new" },
  ]);
});

test("errors render as error rows and images retain Pi fallback", () => {
  assert.deepEqual(
    fileToolBody("edit", {}, { content: [{ type: "text", text: "no match" }] }, true, false),
    { rows: [{ kind: "error", text: "no match" }], hiddenRows: 0 },
  );
  assert.equal(
    fileToolBody("read", {}, { content: [{ type: "image", data: "x", mimeType: "image/png" }] }, false, true),
    undefined,
  );
});
