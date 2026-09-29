import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  FooterComponent,
  InteractiveMode,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  stripTerminalSequences,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import http from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  hubClientUrl,
  listenOnAgentPort,
  parseAgentSeriesStart,
  parseHubAddress,
} from "../hub/net.ts";
import {
  ThinkingAccumulator,
  thinkingBlocksFromMessage,
} from "./thinking.ts";
import {
  fileToolBody,
  type FileToolBody,
} from "./file-tool-renderer.ts";
import {
  defaultToolExpanded,
  type ToolRunStatus,
  toolWebPresentation,
  transitionToolStatus,
} from "./tool-presentation.ts";

const HEARTBEAT_MS = 15_000;
const EXT_LOG = process.env.PI_FWD_LOG;
const PLUGIN_REVISION = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 12);
const PROTOCOL_VERSION = 1;
const AGENT_SERIES_START = parseAgentSeriesStart(process.env.PI_FWD_AGENT_SERIES_START);
const AGENT_LISTEN_HOST = AGENT_SERIES_START === undefined ? "127.0.0.1" : "0.0.0.0";
let cachedMarkedScript: string | undefined;
function markedBrowserScript(): string {
  if (!cachedMarkedScript) {
    const packagePath = createRequire(import.meta.url).resolve("marked/package.json");
    cachedMarkedScript = readFileSync(join(dirname(packagePath), "lib/marked.umd.js"), "utf8");
  }
  return cachedMarkedScript;
}
function extLog(msg: string): void {
  if (!EXT_LOG) return;
  try {
    appendFileSync(EXT_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // ignore
  }
}

function repositoryMetadata(cwd: string): { repoRoot: string; repoName: string } {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return { repoRoot: current, repoName: basename(current) || current };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { repoRoot: cwd, repoName: basename(cwd) || cwd };
}

type SubmitHost = {
  editor?: {
    onSubmit?: (text: string) => unknown;
    onChange?: (text: string) => void;
    setText?: (text: string) => void;
    getText?: () => string;
  };
};
let submitHost: SubmitHost | undefined;
let lastEditor = "";
let broadcastEditor: ((text: string, from: "cli" | "web") => void) | undefined;

type LiveEditor = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  tui?: { requestRender?: (force?: boolean) => void };
  getCursor?: () => { line: number; col: number };
  getLines?: () => string[];
  getText?: () => string;
};
const live = globalThis as unknown as {
  __piFwdEditor?: LiveEditor;
  __piFwdTui?: {
    requestRender?: (force?: boolean) => void;
    getFocusedComponent?: () => { handleInput?: (data: string) => void } | null;
    handleTerminalInput?: (data: string) => void;
  };
  __piFwdOnPaint?: () => void;
  __piFwdOnFooter?: (rawLines: string[]) => void;
  __piFwdPainting?: boolean;
  __piFwdToolDefinitions?: Map<string, unknown>;
  __piFwdMode?: {
    editorContainer?: { render: (width: number) => string[] };
    editor?: LiveEditor;
    getRegisteredToolDefinition?: (toolName: string) => unknown;
    toolOutputExpanded?: boolean;
  };
};
live.__piFwdToolDefinitions ??= new Map();
{
  const proto = Editor.prototype as LiveEditor & {
    __piFwdOrigRender?: (width: number) => string[];
  };
  proto.__piFwdOrigRender ??= proto.render;
  const origRender = proto.__piFwdOrigRender;
  proto.render = function (this: LiveEditor, width: number) {
    live.__piFwdEditor = this;
    if (this.tui) live.__piFwdTui = this.tui;
    const out = origRender.call(this, width);
    const paint = live.__piFwdOnPaint;
    if (paint && !live.__piFwdPainting) queueMicrotask(() => paint());
    return out;
  };
}
{
  const proto = TuiMainScreen.prototype as {
    requestRender: (force?: boolean) => void;
    getFocusedComponent?: () => unknown;
    __piFwdOrigRR?: (force?: boolean) => void;
  };
  proto.__piFwdOrigRR ??= proto.requestRender;
  const origRR = proto.__piFwdOrigRR;
  proto.requestRender = function (this: typeof proto, force?: boolean) {
    live.__piFwdTui = this;
    const result = origRR.call(this, force);
    const focus = this.getFocusedComponent?.();
    if (focus && focus !== live.__piFwdEditor && live.__piFwdOnPaint && !live.__piFwdPainting) {
      queueMicrotask(() => live.__piFwdOnPaint?.());
    }
    return result;
  };
}
{
  const proto = FooterComponent.prototype as {
    render: (width: number) => string[];
    __piFwdOrigRender?: (width: number) => string[];
  };
  proto.__piFwdOrigRender ??= proto.render;
  const origRender = proto.__piFwdOrigRender;
  proto.render = function (this: unknown, width: number) {
    const out = origRender.call(this, width);
    const paint = live.__piFwdOnFooter;
    if (paint) queueMicrotask(() => paint(out));
    return out;
  };
}
{
  const proto = InteractiveMode.prototype as unknown as {
    setupEditorSubmitHandler?: () => void;
    getRegisteredToolDefinition?: (toolName: string) => unknown;
    __piFwdOrigGetToolDefinition?: (toolName: string) => unknown;
    __piFwdSubmitHook?: boolean;
  };
  if (typeof proto.getRegisteredToolDefinition === "function") {
    proto.__piFwdOrigGetToolDefinition ??= proto.getRegisteredToolDefinition;
    const getDefinition = proto.__piFwdOrigGetToolDefinition;
    proto.getRegisteredToolDefinition = function (this: typeof proto, toolName: string) {
      live.__piFwdMode = this as typeof live.__piFwdMode;
      const definition = getDefinition.call(this, toolName);
      if (definition) live.__piFwdToolDefinitions?.set(toolName, definition);
      return definition;
    };
  }
  const orig = proto.setupEditorSubmitHandler;
  if (typeof orig === "function" && !proto.__piFwdSubmitHook) {
    proto.setupEditorSubmitHandler = function (this: SubmitHost) {
      submitHost = this;
      live.__piFwdMode = this as LiveEditor as typeof live.__piFwdMode;
      if (this.editor?.render) live.__piFwdEditor = this.editor as LiveEditor;
      const result = orig.call(this);
      const editor = this.editor as SubmitHost["editor"] & { __piFwdOnChange?: boolean };
      if (editor && !editor.__piFwdOnChange) {
        const prev = editor.onChange;
        editor.onChange = (text: string) => {
          prev?.(text);
          if (text === lastEditor) return;
          lastEditor = text;
          broadcastEditor?.(text, "cli");
        };
        editor.__piFwdOnChange = true;
      }
      return result;
    };
    proto.__piFwdSubmitHook = true;
  }
}
const EDITOR_POLL_MS = 100;
const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_PAYLOAD = 1_000_000;

type SlashCmd = {
  name: string;
  description?: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => Array<{ value: string; label: string; description?: string }> | null | Promise<Array<{
    value: string;
    label: string;
    description?: string;
  }> | null>;
};

type Client = {
  send(obj: unknown): void;
  close(): void;
};
const clientCols = new WeakMap<Client, number>();
const clientVisible = new WeakMap<Client, boolean>();
const clientMobile = new WeakMap<Client, boolean>();
const clientToolExpanded = new WeakMap<Client, Map<string, boolean>>();

function hubBase(): string {
  return hubClientUrl(parseHubAddress(process.env.PI_FWD_HUB_ADDR));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function resolveId(_ctx: ExtensionContext): string {
  // One TUI process = one web attachment. JSONL id changes on /new.
  return String(process.pid);
}

function stripAnsi(s: string): string {
  return stripTerminalSequences(s)
    .replaceAll(CURSOR_MARKER, "")
    .replace(/\u001b_pi:c\u0007/g, "")
    .replace(/\u001b_pi:c/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[\]_P^][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b./g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function clip(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function cheapText(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (typeof value === "string") return clip(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (depth > 4) return "…";
  if (Array.isArray(value)) {
    return value
      .slice(0, 8)
      .map((item) => cheapText(item, depth + 1))
      .filter(Boolean)
      .join(" ");
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") return clip(rec.text);
    if (typeof rec.content === "string") return clip(rec.content);
    if (rec.content !== undefined) return cheapText(rec.content, depth + 1);
    if (typeof rec.role === "string") {
      return `${rec.role}: ${cheapText(rec.content ?? rec.text ?? rec.message, depth + 1)}`;
    }
  }
  return "";
}

function semanticMessageText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => semanticMessageText(item))
      .filter(Boolean)
      .join("");
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.content === "string") return rec.content;
    if (rec.content !== undefined) return semanticMessageText(rec.content);
  }
  return "";
}

function notificationFirstLine(value: string): string {
  const first = stripAnsi(value)
    .split(/\r?\n/)
    .find((line) => line.trim()) ?? "";
  const normalized = first.replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 239)}…` : normalized;
}

function subagentWebData(
  args: unknown,
  result: unknown,
  isError: boolean,
  startedAt: number,
): Record<string, unknown> {
  const argsRecord = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const resultRecord = result && typeof result === "object"
    ? result as Record<string, unknown>
    : {};
  const details = resultRecord.details && typeof resultRecord.details === "object"
    ? resultRecord.details as Record<string, unknown>
    : {};
  const rawResults = details.kind === "pi-subagent" && Array.isArray(details.results)
    ? details.results
    : [];
  const requestedCalls = Array.isArray(argsRecord.calls) ? argsRecord.calls : [];
  const source = rawResults.length ? rawResults : requestedCalls.map((call, index) => ({
    ...(call && typeof call === "object" ? call as Record<string, unknown> : {}),
    callIndex: index,
    exitCode: -1,
    messages: [],
  }));
  const calls = source.slice(0, 8).map((value, fallbackIndex) => {
    const call = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const requested = requestedCalls[fallbackIndex] && typeof requestedCalls[fallbackIndex] === "object"
      ? requestedCalls[fallbackIndex] as Record<string, unknown>
      : {};
    const messages = Array.isArray(call.messages) ? call.messages : [];
    let output = "";
    const steps: Array<{
      startedAt: number;
      preview: string;
      tools: Array<{ name: string; summary: string }>;
    }> = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const text = msg.content
        .filter((part) => part && typeof part === "object" &&
          (part as Record<string, unknown>).type === "text")
        .map((part) => String((part as Record<string, unknown>).text ?? ""))
        .join("");
      if (text.trim()) output = text;
      const tools: Array<{ name: string; summary: string }> = [];
      for (const part of msg.content) {
        if (!part || typeof part !== "object") continue;
        const item = part as Record<string, unknown>;
        if (item.type !== "toolCall" || typeof item.name !== "string") continue;
        let summary = "";
        try {
          summary = JSON.stringify(item.arguments ?? {});
        } catch {
          summary = "";
        }
        tools.push({ name: item.name, summary: clip(summary, 180) });
      }
      const firstTextLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
      const timestamp = typeof msg.timestamp === "number"
        ? msg.timestamp
        : typeof msg.timestamp === "string" ? Date.parse(msg.timestamp) : NaN;
      steps.push({
        startedAt: Number.isFinite(timestamp) ? timestamp : startedAt,
        preview: clip(
          firstTextLine || tools.map((tool) => tool.name).join(", ") || "Assistant step",
          280,
        ),
        tools,
      });
    }
    const exitCode = typeof call.exitCode === "number" ? call.exitCode : -1;
    const failed = exitCode !== -1 && (
      exitCode !== 0 ||
      call.processError === true ||
      call.stopReason === "error" ||
      call.stopReason === "aborted"
    );
    const session = call.session && typeof call.session === "object"
      ? call.session as Record<string, unknown>
      : undefined;
    return {
      index: typeof call.callIndex === "number" ? call.callIndex + 1 : fallbackIndex + 1,
      agent: String(call.agent ?? requested.agent ?? "subagent"),
      prompt: clip(String(call.prompt ?? call.task ?? requested.prompt ?? ""), 50_000),
      status: exitCode === -1 ? "running" : failed ? "failed" : "succeeded",
      output: clip(output, 100_000),
      steps: steps.slice(-30),
      latestStepAt: steps.at(-1)?.startedAt ?? startedAt,
      model: typeof call.model === "string"
        ? call.model
        : typeof requested.model === "string" ? requested.model : "parent model",
      usage: call.usage && typeof call.usage === "object" ? call.usage : {},
      session: session ? {
        handle: String(session.handle ?? ""),
        id: String(session.id ?? ""),
        cwd: String(session.cwd ?? ""),
        created: session.created === true,
      } : undefined,
      error: clip(String(call.errorMessage ?? call.stderr ?? ""), 4000),
    };
  });
  const running = calls.filter((call) => call.status === "running").length;
  const failed = calls.filter((call) => call.status === "failed").length;
  const succeeded = calls.filter((call) => call.status === "succeeded").length;
  return {
    calls,
    status: running
      ? `${succeeded + failed}/${calls.length} done, ${running} running`
      : `${succeeded}/${calls.length} succeeded`,
    isError: isError || failed > 0,
  };
}

function loadBuiltinSlashCommands(): SlashCmd[] {
  try {
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const loaded = createRequire(entry)(join(dirname(entry), "core/slash-commands.js"))
      .BUILTIN_SLASH_COMMANDS as SlashCmd[] | undefined;
    if (Array.isArray(loaded) && loaded.length > 0) return loaded;
  } catch {
    // public package index does not export BUILTIN_SLASH_COMMANDS
  }
  return [
    { name: "settings", description: "Open settings menu" },
    { name: "model", description: "Select model", argumentHint: "<provider/model>" },
    { name: "tree", description: "Navigate session tree" },
    { name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
    { name: "scoped-models", description: "Enable/disable models for cycling" },
    { name: "export", description: "Export session" },
    { name: "import", description: "Import a JSONL session" },
    { name: "share", description: "Share session" },
    { name: "bug", description: "Report a bug", argumentHint: "<description>" },
    { name: "copy", description: "Copy last agent message" },
    { name: "name", description: "Set session display name" },
    { name: "session", description: "Show session info" },
    { name: "changelog", description: "Show changelog entries" },
    { name: "hotkeys", description: "Show keyboard shortcuts" },
    { name: "fork", description: "Fork from a previous user message" },
    { name: "clone", description: "Duplicate the current session" },
    { name: "trust", description: "Save project trust decision" },
    { name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
    { name: "logout", description: "Remove provider authentication" },
    { name: "new", description: "Start a new session" },
    { name: "compact", description: "Manually compact the session context" },
    { name: "resume", description: "Resume a different session" },
    { name: "reload", description: "Reload keybindings, extensions, skills, prompts, themes" },
    { name: "quit", description: "Quit" },
  ];
}

function loadBuiltinToolRenderers(toolName: string, cwd: string): unknown {
  switch (toolName) {
    case "bash":
      return createBashToolDefinition(cwd);
    case "read":
      return createReadToolDefinition(cwd);
    case "edit":
      return createEditToolDefinition(cwd);
    case "write":
      return createWriteToolDefinition(cwd);
    case "grep":
      return createGrepToolDefinition(cwd);
    case "find":
      return createFindToolDefinition(cwd);
    case "ls":
      return createLsToolDefinition(cwd);
    default:
      return undefined;
  }
}

type AnsiLinesToHtml = (lines: string[]) => string;
let cachedAnsiLinesToHtml: AnsiLinesToHtml | undefined;
function ansiLinesHtml(lines: string[]): string {
  if (!cachedAnsiLinesToHtml) {
    try {
      const AnsiToHtml = createRequire(import.meta.url)("ansi-to-html") as new (
        options: Record<string, unknown>,
      ) => { toHtml(value: string): string };
      const converter = new AnsiToHtml({ escapeXML: true, newline: false });
      cachedAnsiLinesToHtml = (rawLines) => rawLines
        .map((line) => `<div class="ansi-line">${converter.toHtml(line) || "&nbsp;"}</div>`)
        .join("");
    } catch (error) {
      extLog(`ANSI renderer unavailable: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      cachedAnsiLinesToHtml = (rawLines) =>
        rawLines.map((line) => `<div>${escapeHtml(stripAnsi(line))}</div>`).join("");
    }
  }
  return cachedAnsiLinesToHtml(lines);
}

function sessionPage(cwd: string, pid: number, sessionTitle: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#202020">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/pi-192.png">
<title>${escapeHtml(sessionTitle)}</title>
<script>
try {
  const savedTheme = localStorage.getItem("pi-fwd-theme") || "auto";
  const dark = savedTheme === "dark" ||
    (savedTheme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {}
</script>
<style>
:root {
  color-scheme: dark;
  --page-bg: #101010;
  --text: #ddd;
  --muted: #888;
  --panel: #171717;
  --panel-head: #202020;
  --panel-soft: #1a1a1a;
  --button: #292929;
  --border: #444;
  --button-border: #555;
  --title: #aaa;
  --tool-text: #bbb;
  --user: #8c8;
  --assistant: #9bd;
  --thinking: #c9a7e8;
  --accent: #4a8;
  --header-bg: #eee;
  --header-text: #181818;
  --header-border: #bbb;
}
:root[data-theme="light"] {
  color-scheme: light;
  --page-bg: #f2f2f2;
  --text: #222;
  --muted: #666;
  --panel: #fff;
  --panel-head: #e9e9e9;
  --panel-soft: #e5e5e5;
  --button: #f7f7f7;
  --border: #bbb;
  --button-border: #aaa;
  --title: #555;
  --tool-text: #444;
  --user: #176b42;
  --assistant: #315f91;
  --thinking: #704898;
  --accent: #287758;
  --header-bg: #181818;
  --header-text: #eee;
  --header-border: #444;
}
pre, .card-body, #composer, #composer * {
  -webkit-user-select: text !important;
  user-select: text !important;
  -webkit-touch-callout: default;
}
.app-header {
  position: sticky;
  top: 0;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  margin: -8px -8px 10px;
  padding: 4px 8px;
  box-sizing: border-box;
  color: var(--header-text);
  background: var(--header-bg);
  border-bottom: 1px solid var(--header-border);
  transform: translateY(0);
  transition: transform 160ms ease;
  will-change: transform;
  -webkit-user-select: none;
  user-select: none;
}
.app-header.hidden { transform: translateY(calc(-100% - 2px)); }
.app-header .spacer { flex: 1; }
.app-header button {
  min-width: 36px;
  min-height: 32px;
  padding: 4px 9px;
  border: 1px solid var(--header-border);
  border-radius: 5px;
  color: var(--header-text);
  background: transparent;
  font: inherit;
}
.app-header button:active { background: color-mix(in srgb, var(--header-text) 16%, transparent); }
#session-title, #session-title-editor {
  max-width: min(60vw, 620px);
  min-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-color: transparent;
  text-align: left;
}
#session-title-editor {
  box-sizing: border-box;
  min-height: 32px;
  padding: 4px 9px;
  color: var(--header-text);
  background: color-mix(in srgb, var(--header-text) 10%, transparent);
  border: 1px solid var(--header-border);
  border-radius: 5px;
  font: inherit;
}
#settings-menu {
  position: fixed;
  z-index: 30;
  top: 48px;
  right: 8px;
  width: min(260px, calc(100vw - 16px));
  box-sizing: border-box;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text);
  background: var(--panel);
  box-shadow: 0 8px 24px #0006;
}
#settings-menu[hidden] { display: none; }
#settings-menu button {
  width: 100%;
  margin-top: 8px;
  padding: 7px;
  color: var(--text);
  background: var(--button);
  border: 1px solid var(--button-border);
  border-radius: 4px;
  font: inherit;
}
#settings-menu a {
  display: block;
  margin-top: 8px;
  padding: 7px;
  color: var(--text);
  background: var(--button);
  border: 1px solid var(--button-border);
  border-radius: 4px;
  text-align: center;
  text-decoration: none;
}
#composer-wrap { position: relative; }
#composer {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 8px;
  border: 2px solid var(--accent);
  white-space: pre;
  overflow: auto;
  background: var(--panel);
  color: var(--text);
  pointer-events: none;
}
#composer .caret { background: var(--user); color: var(--page-bg); }
#kb {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  height: 1.4em;
  z-index: 0;
  margin: 0;
  opacity: 0.01;
  border: 0;
  padding: 0;
  font: inherit;
  background: transparent;
  color: transparent;
}
#kb-tab, #udlr {
  position: absolute;
  top: 0;
  right: 12px;
  z-index: 3;
  transform: translateY(-100%);
  border: 2px solid var(--accent);
  border-bottom: 0;
  background: var(--panel-soft);
  color: var(--user);
  padding: 4px 8px;
  font: inherit;
  border-radius: 6px 6px 0 0;
}
#udlr { display: none; gap: 4px; }
#udlr button {
  font: inherit;
  color: var(--user);
  background: transparent;
  border: 1px solid var(--accent);
  padding: 2px 8px;
}
#log { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.card { border: 1px solid var(--border); border-left: 3px solid #666; border-radius: 4px; background: var(--panel); color: var(--text); overflow: hidden; cursor: pointer; }
.card.user { border-left-color: #5a9; }
.card.assistant { border-left-color: #79c; }
.card.thinking { border-left-color: #9670b8; }
.card.tool, .card.status { border-left-color: #b86; color: var(--tool-text); }
.card.tool-read { border-left-color: #4f9da6; }
.card.tool-write { border-left-color: #4a8f62; }
.card.tool-edit { border-left-color: #c88a32; }
.card.tool-apply_patch { border-left-color: #9167b2; }
.card-head { display: flex; align-items: center; gap: 8px; padding: 5px 8px; background: var(--panel-head); }
.card-head, .card-toggle { cursor: pointer; -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; }
.card-title { font-weight: bold; color: var(--title); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-state { color: var(--muted); font-size: 0.85em; white-space: nowrap; }
.card-state.interrupted { color: #d98b5f; font-weight: bold; }
.card-time { margin-left: auto; color: var(--muted); font-size: 0.85em; white-space: nowrap; }
.card-time.running {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: card-spin 0.8s linear infinite;
}
@keyframes card-spin { to { transform: rotate(360deg); } }
.card.user .card-title { color: var(--user); }
.card.assistant .card-title { color: var(--assistant); }
.card.thinking .card-title { color: var(--thinking); }
.card.tool-read .card-title { color: #68b8c2; }
.card.tool-write .card-title { color: #63b97d; }
.card.tool-edit .card-title { color: #dda04a; }
.card.tool-apply_patch .card-title { color: #b58ad4; }
.card-body { margin: 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; }
.file-tool-body {
  margin: -8px;
  font-family: SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 0.82em;
  font-weight: 400;
  font-synthesis: none;
  line-height: 1.32;
  tab-size: 2;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
  overflow: auto;
}
.file-tool-row {
  display: grid;
  grid-template-columns: 1.6em minmax(2.6em, auto) minmax(0, 1fr);
  min-width: max-content;
  padding: 0 8px;
  white-space: pre;
}
.file-tool-row, .file-tool-row > span {
  font-family: inherit;
  font-size: inherit;
  font-style: normal;
  font-weight: 400;
  line-height: inherit;
  -webkit-text-size-adjust: none;
  text-size-adjust: none;
}
.file-tool-marker, .file-tool-line {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: none;
}
.file-tool-marker { padding-right: 0.45em; }
.file-tool-line { padding-right: 0.8em; }
.file-tool-row.add { background: color-mix(in srgb, #218739 18%, transparent); }
.file-tool-row.remove { background: color-mix(in srgb, #b83232 18%, transparent); }
.file-tool-row.add .file-tool-marker { color: #65c77a; }
.file-tool-row.remove .file-tool-marker { color: #e07878; }
.file-tool-row.meta {
  padding-top: 3px;
  padding-bottom: 3px;
  color: var(--title);
  background: var(--panel-soft);
}
.file-tool-row.error { color: #e07878; }
.file-tool-more { padding: 5px 8px; color: var(--muted); background: var(--panel-soft); }
.markdown { white-space: normal; }
.markdown > :first-child { margin-top: 0; }
.markdown > :last-child { margin-bottom: 0; }
.markdown p, .markdown ul, .markdown ol, .markdown blockquote, .markdown pre { margin: 0.65em 0; }
.markdown h1, .markdown h2, .markdown h3, .markdown h4 { margin: 0.8em 0 0.35em; line-height: 1.2; }
.markdown h1 { font-size: 1.35em; }
.markdown h2 { font-size: 1.2em; }
.markdown h3, .markdown h4 { font-size: 1em; }
.markdown blockquote { margin-left: 0; padding-left: 0.8em; border-left: 3px solid var(--border); color: var(--muted); }
.markdown code { padding: 0.08em 0.28em; border-radius: 3px; background: var(--button); }
.markdown pre { padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--page-bg); overflow: auto; white-space: pre; }
.markdown pre code { padding: 0; background: transparent; }
.markdown a { color: var(--assistant); text-decoration-thickness: 1px; }
.markdown img { max-width: 100%; height: auto; }
.markdown table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; }
.markdown th, .markdown td { padding: 4px 7px; border: 1px solid var(--border); }
.subagent-list { display: grid; gap: 8px; }
.subagent-run { padding: 2px 0; }
.subagent-divider { width: 100%; margin: 3px 0; border: 0; border-top: 1px solid var(--border); }
.subagent-run-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px; font-weight: bold; color: var(--text); }
.subagent-model { color: var(--muted); font-size: 0.88em; font-weight: normal; }
.subagent-state { padding: 1px 5px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: 0.85em; }
.subagent-state.running { color: #c90; }
.subagent-state.succeeded { color: var(--user); }
.subagent-state.failed { color: #d66; }
.subagent-meta { margin-top: 5px; color: var(--muted); font-size: 0.9em; }
.subagent-prompt { margin-top: 7px; padding-left: 8px; border-left: 2px solid var(--border); color: var(--muted); white-space: pre-wrap; }
.subagent-prompt strong, .subagent-output > strong { display: block; margin-bottom: 4px; color: var(--title); }
.subagent-prompt-line { margin-top: 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.subagent-steps { display: grid; gap: 5px; margin-top: 8px; }
.subagent-step { padding: 6px; border: 1px solid var(--border); border-radius: 3px; background: var(--page-bg); }
.subagent-step-head { color: var(--muted); font-size: 0.85em; }
.subagent-step-preview { margin-top: 3px; color: var(--text); white-space: pre-wrap; }
.subagent-activity { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.subagent-activity span { padding: 2px 5px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); background: var(--page-bg); }
.subagent-output { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text); }
.subagent-output.compact { max-height: 11em; overflow: hidden; white-space: pre-wrap; }
.subagent-error { margin-top: 8px; color: #d66; white-space: pre-wrap; }
.card button { font: inherit; color: var(--title); background: var(--button); border: 1px solid var(--button-border); padding: 1px 6px; }
#footer {
  margin: 8px 0 0;
  padding: 8px;
  background: var(--panel-soft);
  color: var(--title);
  white-space: pre;
  overflow: hidden;
}
body { font-family: ui-monospace, monospace; background: var(--page-bg); color: var(--text); }
.hint { color: var(--muted); margin: 0 0 8px; }
#bottom-dock {
  transition: transform 160ms ease;
  will-change: transform;
}
@media (max-width: 899px), (max-height: 599px) {
  body { padding-bottom: calc(var(--bottom-dock-height, 150px) + 12px); }
  #bottom-dock {
    position: fixed;
    z-index: 19;
    left: 0;
    right: 0;
    bottom: var(--keyboard-inset, 0px);
    box-sizing: border-box;
    padding: 8px 8px calc(8px + env(safe-area-inset-bottom));
    background: var(--page-bg);
    border-top: 1px solid var(--border);
    box-shadow: 0 -8px 20px #0004;
    transform: translateY(0);
  }
  #bottom-dock.retracted { transform: translateY(calc(100% + 2px)); }
  #bottom-dock.keyboard-open { padding-bottom: 0; }
  #bottom-dock.keyboard-open #footer { display: none; }
  #footer { margin-bottom: 0; }
}
@media (min-width: 900px) and (min-height: 600px) {
  body { padding-bottom: calc(var(--bottom-dock-height, 150px) + 8px); }
  .app-header { transform: none !important; }
  #bottom-dock {
    position: fixed;
    z-index: 19;
    left: 0;
    right: 0;
    bottom: 0;
    box-sizing: border-box;
    padding: 8px;
    background: var(--page-bg);
    border-top: 1px solid var(--border);
    box-shadow: 0 -8px 20px #0004;
  }
  #footer { margin-bottom: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .app-header, #bottom-dock { transition: none; }
}
</style>
<header id="app-header" class="app-header">
  <button type="button" id="back-button" aria-label="Back to sessions">←</button>
  <button type="button" id="session-title" aria-label="Edit session title">${escapeHtml(sessionTitle)}</button>
  <span class="spacer"></span>
  <button type="button" id="theme-toggle" aria-label="Switch color theme"></button>
  <button type="button" id="settings-button" aria-label="Browser settings">⚙</button>
</header>
<div id="settings-menu" hidden>
  <strong>Browser settings</strong>
  <div id="theme-mode-label"></div>
  <button type="button" id="theme-auto">Follow system theme</button>
  <button type="button" id="sound-toggle"></button>
  <a href="./system-prompt" target="_blank" rel="noopener">Show system prompt ↗</a>
</div>
<div id="log"><section class="card status"><div class="card-head"><span class="card-title">pi-fwd session</span></div><pre class="card-body">cwd: ${escapeHtml(cwd)}
pid: ${pid}</pre></section></div>
<div id="bottom-dock">
<div id="composer-wrap">
<button type="button" id="kb-tab">keyboard</button>
<div id="udlr">
<button type="button" data-dir="up">↑</button>
<button type="button" data-dir="down">↓</button>
<button type="button" data-dir="left">←</button>
<button type="button" data-dir="right">→</button>
<button type="button" data-dir="escape">esc</button>
</div>
<pre id="composer">click here, then type</pre>
<textarea id="kb" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></textarea>
</div>
<pre id="footer"></pre>
</div>
<script>${markedBrowserScript()}</script>
<script>
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
}
const log = document.getElementById("log");
const composer = document.getElementById("composer");
const wrap = document.getElementById("composer-wrap");
const kb = document.getElementById("kb");
const kbTab = document.getElementById("kb-tab");
const footer = document.getElementById("footer");
const appHeader = document.getElementById("app-header");
const sessionTitleButton = document.getElementById("session-title");
const themeToggle = document.getElementById("theme-toggle");
const settingsButton = document.getElementById("settings-button");
const settingsMenu = document.getElementById("settings-menu");
const bottomDock = document.getElementById("bottom-dock");
const desktopDock = matchMedia("(min-width: 900px) and (min-height: 600px)");
const themeMedia = matchMedia("(prefers-color-scheme: dark)");
const soundToggle = document.getElementById("sound-toggle");
let themeMode;
try { themeMode = localStorage.getItem("pi-fwd-theme") || "auto"; }
catch { themeMode = "auto"; }
let soundEnabled = true;
try {
  const savedSound = localStorage.getItem("pi-sound-enabled");
  soundEnabled = savedSound === null ? true : savedSound === "true";
} catch {}
let audioContext;
function getAudioContext() {
  if (audioContext && audioContext.state !== "closed") return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try { audioContext = new AudioContextClass(); }
  catch { return null; }
  return audioContext;
}
function unlockAudio(force = false) {
  if (!force && !soundEnabled) return;
  const context = getAudioContext();
  if (context?.state === "suspended") context.resume().catch(() => {});
}
function playDoneSound() {
  if (!soundEnabled) return;
  const context = getAudioContext();
  if (!context) return;
  const play = () => {
    const now = context.currentTime;
    [523.25, 659.25].forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = now + index * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.45);
      oscillator.start(start);
      oscillator.stop(start + 0.45);
    });
  };
  if (context.state === "suspended") context.resume().then(play).catch(() => {});
  else {
    try { play(); } catch {}
  }
}
function syncSoundToggle() {
  soundToggle.textContent = soundEnabled ? "Sound: on" : "Sound: off";
  soundToggle.setAttribute("aria-pressed", String(soundEnabled));
}
soundToggle.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  try { localStorage.setItem("pi-sound-enabled", String(soundEnabled)); } catch {}
  if (soundEnabled) unlockAudio(true);
  syncSoundToggle();
});
document.addEventListener("pointerdown", () => unlockAudio(), { passive: true });
document.addEventListener("keydown", () => unlockAudio(), { passive: true });
syncSoundToggle();
function resolvedTheme() {
  return themeMode === "auto" ? (themeMedia.matches ? "dark" : "light") : themeMode;
}
function applyTheme() {
  const current = resolvedTheme();
  document.documentElement.dataset.theme = current;
  document.querySelector('meta[name="theme-color"]').content =
    current === "dark" ? "#202020" : "#f2f2f2";
  themeToggle.textContent = current === "dark" ? "☀" : "☾";
  themeToggle.title = current === "dark" ? "Switch to light theme" : "Switch to dark theme";
  document.getElementById("theme-mode-label").textContent =
    "Theme: " + themeMode + (themeMode === "auto" ? " (" + current + ")" : "");
}
function setThemeMode(mode) {
  themeMode = mode;
  try { localStorage.setItem("pi-fwd-theme", mode); } catch {}
  applyTheme();
}
document.getElementById("back-button").addEventListener("click", () => {
  location.href = new URL("../../", location.href).href;
});
sessionTitleButton.addEventListener("click", () => {
  if (document.getElementById("session-title-editor")) return;
  const editor = document.createElement("input");
  editor.id = "session-title-editor";
  editor.type = "text";
  editor.value = sessionTitleButton.textContent || "";
  editor.setAttribute("aria-label", "Session title");
  sessionTitleButton.replaceWith(editor);
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    editor.replaceWith(sessionTitleButton);
    if (commit) sendKeyMessage({ type: "set-session-title", title: editor.value.trim() });
  };
  editor.addEventListener("blur", () => finish(true), { once: true });
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      editor.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  editor.focus();
  editor.select();
});
themeToggle.addEventListener("click", () => {
  setThemeMode(resolvedTheme() === "dark" ? "light" : "dark");
});
settingsButton.addEventListener("click", () => {
  settingsMenu.hidden = !settingsMenu.hidden;
});
document.getElementById("theme-auto").addEventListener("click", () => {
  setThemeMode("auto");
  settingsMenu.hidden = true;
});
themeMedia.addEventListener("change", () => {
  if (themeMode === "auto") applyTheme();
});
document.addEventListener("pointerdown", (ev) => {
  if (!settingsMenu.hidden && !settingsMenu.contains(ev.target) && ev.target !== settingsButton) {
    settingsMenu.hidden = true;
  }
});
let lastScrollY = window.scrollY;
function syncDesktopDock() {
  document.documentElement.style.setProperty(
    "--bottom-dock-height",
    Math.ceil(bottomDock.getBoundingClientRect().height + 30) + "px",
  );
  if (desktopDock.matches) {
    appHeader.classList.remove("hidden");
    bottomDock.classList.remove("retracted");
  }
}
window.addEventListener("scroll", () => {
  if (desktopDock.matches) {
    appHeader.classList.remove("hidden");
    lastScrollY = window.scrollY;
    return;
  }
  const nextY = Math.max(0, window.scrollY);
  const delta = nextY - lastScrollY;
  const atBottom = window.innerHeight + nextY >=
    document.documentElement.scrollHeight - 12;
  if (nextY < 12) {
    appHeader.classList.remove("hidden");
    bottomDock.classList.remove("retracted");
  } else if (atBottom) {
    appHeader.classList.add("hidden");
    bottomDock.classList.remove("retracted");
  } else if (delta > 4) {
    appHeader.classList.add("hidden");
    if (document.activeElement !== kb) bottomDock.classList.add("retracted");
  } else if (delta < -4) {
    appHeader.classList.remove("hidden");
    bottomDock.classList.remove("retracted");
  }
  lastScrollY = nextY;
}, { passive: true });
desktopDock.addEventListener("change", () => {
  syncDesktopDock();
  syncKeyboardInset();
  sendSize();
});
new ResizeObserver(syncDesktopDock).observe(bottomDock);
syncDesktopDock();
applyTheme();
const KB_HOLD = "\\u200b";
function resetKb() { kb.value = KB_HOLD; }
function sendKeyMessage(message) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(message));
}
function sendKey(data) {
  sendKeyMessage({ type: "key", data: data });
}
resetKb();
const udlr = document.getElementById("udlr");
const ARROWS = {
  escape: "\\u001b",
  up: "\\u001b[A",
  down: "\\u001b[B",
  right: "\\u001b[C",
  left: "\\u001b[D",
};
const visualViewportApi = window.visualViewport;
let keyboardViewportBase = visualViewportApi
  ? Math.max(document.documentElement.clientHeight, visualViewportApi.height + visualViewportApi.offsetTop)
  : window.innerHeight;
function syncKeyboardInset() {
  const focused = document.activeElement === kb;
  if (!visualViewportApi || desktopDock.matches || !focused) {
    document.documentElement.style.setProperty("--keyboard-inset", "0px");
    bottomDock.classList.remove("keyboard-open");
    if (visualViewportApi && !focused) {
      keyboardViewportBase = Math.max(
        document.documentElement.clientHeight,
        visualViewportApi.height + visualViewportApi.offsetTop,
      );
    }
    return;
  }
  const visibleBottom = visualViewportApi.offsetTop + visualViewportApi.height;
  const layoutBottom = Math.max(keyboardViewportBase, document.documentElement.clientHeight);
  const inset = Math.max(0, layoutBottom - visibleBottom);
  const open = inset > 80;
  document.documentElement.style.setProperty("--keyboard-inset", (open ? inset : 0) + "px");
  bottomDock.classList.toggle("keyboard-open", open);
  if (open) bottomDock.classList.remove("retracted");
}
function setKbOpen(open) {
  kbTab.style.display = open ? "none" : "";
  udlr.style.display = open ? "flex" : "none";
  if (open) bottomDock.classList.remove("retracted");
}
kbTab.addEventListener("click", (ev) => {
  ev.preventDefault();
  resetKb();
  kb.focus();
});
kb.addEventListener("focus", () => {
  setKbOpen(true);
  requestAnimationFrame(syncKeyboardInset);
});
kb.addEventListener("blur", () => {
  setKbOpen(false);
  requestAnimationFrame(syncKeyboardInset);
});
visualViewportApi?.addEventListener("resize", syncKeyboardInset);
visualViewportApi?.addEventListener("scroll", syncKeyboardInset);
window.addEventListener("orientationchange", () => {
  setTimeout(syncKeyboardInset, 100);
});
udlr.addEventListener("pointerdown", (ev) => {
  ev.preventDefault();
  const btn = ev.target.closest("button");
  if (!btn || !btn.dataset.dir) return;
  sendKey(ARROWS[btn.dataset.dir]);
});
kb.addEventListener("input", () => {
  const v = kb.value;
  if (v.length < KB_HOLD.length) sendKey("\\u007f");
  else {
    const extra = v.slice(KB_HOLD.length);
    for (const ch of extra) sendKey(ch);
  }
  resetKb();
});
kb.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault();
    sendKey(ev.shiftKey ? "\\u001b[13;2~" : "\\r");
  }
  if (ev.key === "Backspace" && kb.value === KB_HOLD) { ev.preventDefault(); sendKey("\\u007f"); }
  if (ev.key === "Escape") { ev.preventDefault(); sendKey("\\u001b"); }
  if (ev.key === "ArrowUp") { ev.preventDefault(); sendKey("\\u001b[A"); }
  if (ev.key === "ArrowDown") { ev.preventDefault(); sendKey("\\u001b[B"); }
  if (ev.key === "ArrowRight") { ev.preventDefault(); sendKey("\\u001b[C"); }
  if (ev.key === "ArrowLeft") { ev.preventDefault(); sendKey("\\u001b[D"); }
});
const proto = location.protocol === "https:" ? "wss:" : "ws:";
const wsUrl = proto + "//" + location.host + location.pathname;
let ws;
let reloadPending = false;
function setWsState(text) {
  const el = document.getElementById("wsstate");
  if (el) el.textContent = text;
}
function bindWs(socket) {
  socket.addEventListener("open", () => {
    setWsState("ws connected");
    lastSentCols = 0;
    sendSize();
    sendVisibility();
  });
  socket.addEventListener("error", () => setWsState("ws error"));
  socket.addEventListener("close", () => {
    if (reloadPending) return;
    setWsState("ws closed; retrying");
    setTimeout(connectWs, 800);
  });
  socket.onmessage = onWsMessage;
}
function connectWs() {
  ws = new WebSocket(wsUrl);
  bindWs(ws);
}
function sendVisibility() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "visibility", visible: document.visibilityState === "visible" }));
  }
}
document.addEventListener("visibilitychange", sendVisibility);
function keyData(ev) {
  if (ev.ctrlKey && ev.key === "c") return "\\u0003";
  if (ev.ctrlKey && ev.key === "d") return "\\u0004";
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  if (ev.key === "Enter") return ev.shiftKey ? "\\u001b[13;2~" : "\\r";
  if (ev.key === "Escape") return "\\u001b";
  if (ev.key === "Tab") return "\\t";
  if (ev.key === "Backspace") return "\\u007f";
  if (ev.key === "ArrowUp") return "\\u001b[A";
  if (ev.key === "ArrowDown") return "\\u001b[B";
  if (ev.key === "ArrowRight") return "\\u001b[C";
  if (ev.key === "ArrowLeft") return "\\u001b[D";
  if (ev.key.length === 1) return ev.key;
  return null;
}
function escapeMarkdownHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function sanitizeMarkdownUrl(value) {
  const href = String(value || "").trim().replace(/[\\x00-\\x1f\\x7f]/g, "");
  if (!href) return href;
  const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  return scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1]) ? null : href;
}
marked.use({
  breaks: true,
  gfm: true,
  tokenizer: {
    html() { return undefined; },
    tag() { return undefined; },
  },
  renderer: {
    link(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return this.parser.parseInline(token.tokens);
      let out = '<a href="' + escapeMarkdownHtml(href) +
        '" target="_blank" rel="noopener noreferrer"';
      if (token.title) out += ' title="' + escapeMarkdownHtml(token.title) + '"';
      return out + ">" + this.parser.parseInline(token.tokens) + "</a>";
    },
    image(token) {
      const href = sanitizeMarkdownUrl(token.href);
      if (href === null) return escapeMarkdownHtml(token.text || "");
      let out = '<img src="' + escapeMarkdownHtml(href) +
        '" alt="' + escapeMarkdownHtml(token.text || "") +
        '" loading="lazy" referrerpolicy="no-referrer"';
      if (token.title) out += ' title="' + escapeMarkdownHtml(token.title) + '"';
      return out + ">";
    },
    code(token) {
      return "<pre><code>" + escapeMarkdownHtml(token.text) + "</code></pre>";
    },
    codespan(token) {
      return "<code>" + escapeMarkdownHtml(token.text) + "</code>";
    },
  },
});
function renderMarkdown(value) {
  return marked.parse(String(value || ""));
}
const header = log.innerHTML;
function cardText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(cardText).filter(Boolean).join("\\n");
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (typeof value.content === "string") return value.content;
    if (Array.isArray(value.content)) return cardText(value.content);
  }
  return "";
}
function syncCardDisclosure(card) {
  const expanded = card.dataset.expanded !== "false";
  const title = card.dataset.title || "";
  const preview = card.dataset.preview || "";
  card.querySelector(".card-title").textContent = !expanded && preview
    ? title + " · " + preview
    : title;
  const toggle = card.querySelector(".card-toggle");
  toggle.textContent = expanded ? "↑" : "↓";
  toggle.title = expanded ? "Show less" : "Show more";
  toggle.setAttribute("aria-label", toggle.title);
  const body = card.querySelector(".card-body");
  if (!card.dataset.itemId?.startsWith("tool:")) {
    const displayText = expanded ? (body._fullText || "(no text)") : (preview || "(no text)");
    if (card.classList.contains("assistant") || card.classList.contains("thinking")) {
      body.classList.add("markdown");
      body.innerHTML = renderMarkdown(displayText);
    } else {
      body.classList.remove("markdown");
      body.textContent = displayText;
    }
  }
}
function syncCardTiming(card, timing) {
  if (!timing) return;
  const state = card.querySelector(".card-state");
  if (state && timing.status !== undefined) {
    state.textContent = timing.status === "interrupted" ? "Interrupted" : "";
    state.className = "card-state" +
      (timing.status === "interrupted" ? " interrupted" : "");
  }
  const element = card.querySelector(".card-time");
  if (!element) return;
  if (timing.status === "interrupted" && !timing.completedAt) {
    element.classList.remove("running");
    element.textContent = "";
    element.title = "Interrupted";
    element.setAttribute("aria-label", "Interrupted");
  } else if (timing.completedAt) {
    element.classList.remove("running");
    const completed = new Date(
      typeof timing.completedAt === "number" ? timing.completedAt : String(timing.completedAt),
    );
    element.textContent = Number.isNaN(completed.getTime())
      ? ""
      : completed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    element.title = "Completed " + completed.toLocaleString();
    element.setAttribute("aria-label", element.title);
  } else if (timing.running) {
    element.textContent = "";
    element.classList.add("running");
    element.title = "Running";
    element.setAttribute("aria-label", "Running");
  }
}
function addCard(title, text, kind, itemId, bodyHtml, expanded, timing) {
  const follow = window.innerHeight + window.scrollY >=
    document.documentElement.scrollHeight - 80;
  const preview = String(text || "").split("\\n").find((line) => line.trim())?.trim() || "";
  const existing = itemId
    ? log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]')
    : null;
  if (existing) {
    const body = existing.querySelector(".card-body");
    if (bodyHtml !== undefined) body.innerHTML = bodyHtml;
    else body.textContent = text || "(no text)";
    body._fullText = text || "(no text)";
    body._fullHtml = bodyHtml;
    existing.dataset.title = title;
    existing.dataset.preview = preview;
    if (expanded !== undefined) existing.dataset.expanded = String(expanded);
    syncCardDisclosure(existing);
    syncCardTiming(existing, timing);
    if (follow) requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
    return existing;
  }
  const card = document.createElement("section");
  card.className = "card " + kind;
  if (itemId) card.dataset.itemId = itemId;
  card.dataset.title = title;
  card.dataset.preview = preview;
  card.dataset.expanded = String(expanded !== false);
  const head = document.createElement("div");
  head.className = "card-head";
  const label = document.createElement("span");
  label.className = "card-title";
  label.textContent = title;
  const toggle = document.createElement("button");
  toggle.className = "card-toggle";
  toggle.type = "button";
  const time = document.createElement("span");
  time.className = "card-time";
  const state = document.createElement("span");
  state.className = "card-state";
  const body = document.createElement("div");
  body.className = "card-body";
  if (bodyHtml !== undefined) body.innerHTML = bodyHtml;
  else body.textContent = text || "(no text)";
  body._fullText = text || "(no text)";
  body._fullHtml = bodyHtml;
  const toggleBody = () => {
    const nextExpanded = card.dataset.expanded === "false";
    card.dataset.expanded = String(nextExpanded);
    syncCardDisclosure(card);
    if (itemId && itemId.startsWith("tool:")) {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({
          type: "tool-expanded",
          toolCallId: itemId.slice(5),
          expanded: nextExpanded,
        }));
      }
    }
  };
  toggle.addEventListener("click", (ev) => {
    ev.stopPropagation();
    toggleBody();
  });
  card.addEventListener("click", (ev) => {
    if (ev.detail > 1) return;
    if (ev.target.closest("a, button, input, textarea, select")) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    toggleBody();
  });
  head.append(label, state, time, toggle);
  card.append(head, body);
  syncCardDisclosure(card);
  syncCardTiming(card, timing);
  log.append(card);
  if (follow) requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
  return card;
}
function renderEvent(msg) {
  const event = String(msg.event || "event");
  const role = String(msg.role || "");
  const text = cardText(msg.text);
  if (event === "agent_settled") {
    playDoneSound();
    return;
  }
  if (event === "message_start" || event === "tool_call"
      || event === "tool_execution_start") return;
  if (event === "message_update" && role === "assistant" && msg.id) {
    const itemId = "assistant:" + String(msg.id);
    const existing = log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]');
    const previous = existing?.querySelector(".card-body")?._fullText || "";
    const next = msg.text !== undefined ? text : previous + cardText(msg.delta);
    if (next) addCard("Assistant", next, "assistant", itemId, undefined, undefined, {
      running: true,
      startedAt: msg.startedAt,
    });
    return;
  }
  if (event === "thinking_update" && msg.id) {
    const itemId = "thinking:" + String(msg.id);
    const existing = log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]');
    const completed = msg.completedAt !== undefined;
    const expanded = completed ? false : existing ? undefined : true;
    if (text) addCard("Thinking", text, "thinking", itemId, undefined, expanded, {
      running: !completed,
      startedAt: msg.startedAt,
      completedAt: msg.completedAt,
    });
    return;
  }
  if ((event === "history" || event === "message_end")
      && (role === "user" || role === "assistant")) {
    if (!text.trim()) return;
    const itemId = role === "assistant" && msg.id
      ? "assistant:" + String(msg.id)
      : undefined;
    addCard(role === "user" ? "You" : "Assistant", text, role, itemId,
      undefined, undefined, { completedAt: msg.completedAt || msg.timestamp });
    return;
  }
  // message_end is a lifecycle boundary, not a generic transcript item.
  // Tool results and internal/custom messages have their own presentation.
  if (event === "message_end") return;
  const details = [];
  for (const key of ["toolName", "toolCallId", "isError", "reason"]) {
    if (msg[key] !== undefined) details.push(key + ": " + String(msg[key]));
  }
  if (text) details.push(text);
  addCard(event.replaceAll("_", " "), details.join("\\n") || "No additional details",
    event.startsWith("tool_") ? "tool" : "status");
}
function renderTtyItem(msg) {
  const itemId = String(msg.id || "");
  const existing = itemId
    ? log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]')
    : null;
  const expanded = !existing && !desktopDock.matches ? false : msg.expanded !== false;
  const fileToolKinds = new Set(["read", "write", "edit", "apply_patch"]);
  const toolKind = fileToolKinds.has(String(msg.toolKind)) ? String(msg.toolKind) : "";
  addCard(msg.title || "terminal output", (msg.lines || []).map(String).join("\\n"),
    "tool" + (toolKind ? " tool-" + toolKind : ""), itemId, msg.html, expanded,
    msg.status === "interrupted"
      ? { status: "interrupted", completedAt: msg.completedAt }
      : msg.completedAt
        ? { status: msg.status, completedAt: msg.completedAt }
        : { status: msg.status, running: true, startedAt: msg.startedAt });
}
function renderFileToolItem(msg) {
  const itemId = String(msg.id || "");
  const existing = itemId
    ? log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]')
    : null;
  const expanded = !existing && !desktopDock.matches ? false : msg.expanded !== false;
  const fileToolKinds = new Set(["read", "write", "edit", "apply_patch"]);
  const toolKind = fileToolKinds.has(String(msg.toolKind)) ? String(msg.toolKind) : "";
  addCard(msg.title || "file tool", "",
    "tool" + (toolKind ? " tool-" + toolKind : ""), itemId, String(msg.html || ""), expanded,
    msg.status === "interrupted"
      ? { status: "interrupted", completedAt: msg.completedAt }
      : msg.completedAt
        ? { status: msg.status, completedAt: msg.completedAt }
        : { status: msg.status, running: true, startedAt: msg.startedAt });
}
function subagentUsageText(usage, model) {
  const compact = (value) => {
    const n = Number(value || 0);
    return n >= 1000000 ? (n / 1000000).toFixed(1) + "M"
      : n >= 1000 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + "k"
      : String(n);
  };
  const parts = [];
  if (usage?.turns) parts.push(usage.turns + (usage.turns === 1 ? " turn" : " turns"));
  if (usage?.input) parts.push("↑" + compact(usage.input));
  if (usage?.output) parts.push("↓" + compact(usage.output));
  if (usage?.cacheRead) parts.push("R" + compact(usage.cacheRead));
  if (usage?.cost) parts.push("$" + Number(usage.cost).toFixed(4));
  if (model) parts.push(String(model));
  return parts.join(" ");
}
function relativeAge(timestamp) {
  const seconds = Math.max(0, Math.floor((Date.now() - Number(timestamp || Date.now())) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return seconds + "s ago";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m ago";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  return Math.floor(hours / 24) + "d ago";
}
function refreshRelativeTimes() {
  for (const element of document.querySelectorAll("[data-relative-time]")) {
    element.textContent = relativeAge(element.dataset.relativeTime);
  }
}
setInterval(refreshRelativeTimes, 1000);
function renderSubagentItem(msg) {
  const itemId = String(msg.id || "");
  const existing = itemId
    ? log.querySelector('[data-item-id="' + CSS.escape(itemId) + '"]')
    : null;
  const expanded = !existing && !desktopDock.matches ? false : msg.expanded !== false;
  const list = document.createElement("div");
  list.className = "subagent-list";
  for (const [runIndex, raw] of (Array.isArray(msg.calls) ? msg.calls : []).entries()) {
    if (runIndex > 0) {
      const divider = document.createElement("hr");
      divider.className = "subagent-divider";
      list.append(divider);
    }
    const call = raw && typeof raw === "object" ? raw : {};
    const run = document.createElement("div");
    run.className = "subagent-run";
    const head = document.createElement("div");
    head.className = "subagent-run-head";
    const name = document.createElement("span");
    name.textContent = String(call.index || "?") + ": " + String(call.agent || "subagent");
    const model = document.createElement("span");
    model.className = "subagent-model";
    model.textContent = String(call.model || "parent model");
    const state = document.createElement("span");
    state.className = "subagent-state " + String(call.status || "running");
    state.textContent = String(call.status || "running");
    head.append(name, model, state);
    run.append(head);

    const usage = subagentUsageText(call.usage, "");
    const session = call.session && typeof call.session === "object" ? call.session : null;
    const latest = document.createElement("span");
    latest.dataset.relativeTime = String(call.latestStepAt || Date.now());
    latest.textContent = relativeAge(call.latestStepAt);
    if (expanded && (session || usage || call.latestStepAt)) {
      const meta = document.createElement("div");
      meta.className = "subagent-meta";
      const bits = [];
      if (session?.handle) bits.push("session=" + session.handle);
      if (session?.cwd) bits.push(String(session.cwd));
      if (usage) bits.push(usage);
      if (bits.length) meta.append(bits.join(" · ") + " · ");
      meta.append("latest step ", latest);
      run.append(meta);
    } else {
      const compactMeta = document.createElement("div");
      compactMeta.className = "subagent-meta";
      compactMeta.append("latest step ", latest);
      run.append(compactMeta);
    }
    if (call.prompt) {
      const prompt = document.createElement("div");
      prompt.className = expanded ? "subagent-prompt" : "subagent-prompt-line";
      if (expanded) {
        const label = document.createElement("strong");
        label.textContent = "Session prompt";
        const text = document.createElement("div");
        text.textContent = String(call.prompt);
        prompt.append(label, text);
      } else {
        prompt.textContent = String(call.prompt).split(/\\r?\\n/).find((line) => line.trim()) || "";
      }
      run.append(prompt);
    }
    const steps = Array.isArray(call.steps) ? call.steps : [];
    if (expanded && steps.length) {
      const stepList = document.createElement("div");
      stepList.className = "subagent-steps";
      for (const [stepIndex, item] of steps.entries()) {
        const step = document.createElement("div");
        step.className = "subagent-step";
        const stepHead = document.createElement("div");
        stepHead.className = "subagent-step-head";
        const stepTime = document.createElement("span");
        stepTime.dataset.relativeTime = String(item.startedAt || call.latestStepAt || Date.now());
        stepTime.textContent = relativeAge(item.startedAt);
        stepHead.append("Step " + (stepIndex + 1) + " · ", stepTime);
        const preview = document.createElement("div");
        preview.className = "subagent-step-preview";
        preview.textContent = String(item.preview || "Assistant step");
        step.append(stepHead, preview);
        const tools = Array.isArray(item.tools) ? item.tools : [];
        if (tools.length) {
          const activity = document.createElement("div");
          activity.className = "subagent-activity";
          for (const tool of tools) {
            const chip = document.createElement("span");
            chip.textContent = String(tool.name || "tool") +
              (tool.summary ? " " + String(tool.summary) : "");
            activity.append(chip);
          }
          step.append(activity);
        }
        stepList.append(step);
      }
      run.append(stepList);
    }
    if (expanded && call.output && call.status !== "running") {
      const output = document.createElement("div");
      output.className = "subagent-output markdown";
      const label = document.createElement("strong");
      label.textContent = "Reply to parent";
      const reply = document.createElement("div");
      reply.innerHTML = renderMarkdown(String(call.output));
      output.append(label, reply);
      run.append(output);
    } else if (call.status === "running") {
      const waiting = document.createElement("div");
      waiting.className = "subagent-meta";
      waiting.textContent = "Waiting for output…";
      run.append(waiting);
    }
    if (call.status === "failed" && call.error) {
      const error = document.createElement("div");
      error.className = "subagent-error";
      error.textContent = String(call.error);
      run.append(error);
    }
    list.append(run);
  }
  refreshRelativeTimes();
  addCard("Subagents", String(msg.status || "delegating"), "tool subagent-card",
    itemId, list.outerHTML, expanded,
    msg.toolStatus === "interrupted"
      ? { status: "interrupted", completedAt: msg.completedAt }
      : msg.completedAt
        ? { status: msg.toolStatus, completedAt: msg.completedAt }
        : { status: msg.toolStatus, running: true, startedAt: msg.startedAt });
}
let footerLines = [];
function colsOf(el) {
  const cs = getComputedStyle(el);
  const inner = el.clientWidth
    - (parseFloat(cs.paddingLeft) || 0)
    - (parseFloat(cs.paddingRight) || 0);
  const probe = document.createElement("span");
  probe.textContent = "0";
  probe.style.cssText = "position:absolute;visibility:hidden;font:" + cs.font;
  document.body.append(probe);
  const ch = probe.getBoundingClientRect().width || 8;
  probe.remove();
  return Math.max(20, Math.floor(inner / ch));
}
function footerCols() { return colsOf(footer); }
let lastSentCols = 0;
let lastSentMobile;
function sendSize() {
  const cols = colsOf(wrap);
  const mobile = !desktopDock.matches;
  if (!ws || (cols === lastSentCols && mobile === lastSentMobile) || ws.readyState !== 1) return;
  lastSentCols = cols;
  lastSentMobile = mobile;
  ws.send(JSON.stringify({ type: "size", cols: cols, mobile: mobile }));
}
function reflowFooterLine(line, cols) {
  const m = String(line).match(/^(.*?)(\\s{4,})(\\S.*)$/);
  if (!m) {
    return line.length > cols ? line.slice(0, Math.max(0, cols - 1)) + "\u2026" : line;
  }
  const left = m[1];
  const right = m[3];
  if (left.length + 2 + right.length > cols) {
    const keep = Math.max(0, cols - left.length - 2);
    return left + "  " + (keep < right.length ? right.slice(0, Math.max(0, keep - 1)) + "\u2026" : right);
  }
  return left + " ".repeat(cols - left.length - right.length) + right;
}
function paintFooter(lines) {
  footerLines = lines.map(String);
  const cols = footerCols();
  footer.textContent = footerLines.map((line) => reflowFooterLine(line, cols)).join("\\n");
}
new ResizeObserver(() => {
  if (footerLines.length) paintFooter(footerLines);
  sendSize();
}).observe(footer);
new ResizeObserver(() => sendSize()).observe(wrap);
function onWsMessage(ev) {
  let msg;
  try { msg = JSON.parse(String(ev.data)); } catch { return; }
  if (msg.type === "reset") {
    log.innerHTML = header;
    reloadPending = true;
    setWsState("session changed; reloading");
    setTimeout(() => location.reload(), 500);
    return;
  }
  if (msg.type === "event") renderEvent(msg);
  if (msg.type === "tty-item") renderTtyItem(msg);
  if (msg.type === "file-tool-item") renderFileToolItem(msg);
  if (msg.type === "subagent-item") renderSubagentItem(msg);
  if (msg.type === "session-title" && msg.title) {
    sessionTitleButton.textContent = String(msg.title);
    document.title = String(msg.title);
  }
  if (msg.type === "composer" && msg.lines) {
    const lines = msg.lines.map(String);
    const cursor = msg.cursor;
    composer.replaceChildren();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const row = document.createElement("div");
      if (cursor && cursor.line === i) {
        const col = Math.max(0, Math.min(line.length, cursor.col | 0));
        if (col > 0) row.append(line.slice(0, col));
        const caret = document.createElement("span");
        caret.className = "caret";
        caret.textContent = col < line.length ? line.slice(col, col + 1) : " ";
        row.append(caret);
        if (col + 1 < line.length) row.append(line.slice(col + 1));
      } else {
        row.textContent = line.length ? line : " ";
      }
      composer.append(row);
    }
  }
  if (msg.type === "footer" && msg.lines) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount && footer.contains(sel.anchorNode)) return;
    paintFooter(msg.lines);
  }
}
document.addEventListener("keydown", (ev) => {
  if (ev.target === kb || ev.target === document.getElementById("session-title-editor")) return;
  if (
    (ev.ctrlKey || ev.metaKey) &&
    ev.key.toLowerCase() === "c" &&
    window.getSelection()?.isCollapsed === false
  ) return;
  const data = keyData(ev);
  if (data == null) return;
  ev.preventDefault();
  sendKey(data);
}, true);
document.addEventListener("paste", (ev) => {
  if (ev.target === document.getElementById("session-title-editor")) return;
  const text = ev.clipboardData?.getData("text/plain");
  if (text == null || !text.length) return;
  ev.preventDefault();
  sendKey("\\u001b[200~" + text + "\\u001b[201~");
  if (ev.target === kb) resetKb();
}, true);
connectWs();
</script>
`;
}

function systemPromptPage(promptText: string, title: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — system prompt</title>
<style>
:root { color-scheme: light dark; }
body { max-width: 980px; margin: 0 auto; padding: 20px; font: 16px/1.5 system-ui, sans-serif; }
header { position: sticky; top: 0; padding: 10px 0; background: Canvas; border-bottom: 1px solid GrayText; }
article { overflow-wrap: anywhere; }
pre { padding: 12px; overflow: auto; border: 1px solid GrayText; border-radius: 5px; }
code { font-family: ui-monospace, monospace; }
table { display: block; overflow-x: auto; border-collapse: collapse; }
th, td { padding: 5px 8px; border: 1px solid GrayText; }
blockquote { margin-left: 0; padding-left: 1em; border-left: 3px solid GrayText; }
</style>
<header><strong>${escapeHtml(title)}</strong> · system prompt</header>
<article id="prompt"></article>
<script type="text/plain" id="prompt-source">${escapeHtml(promptText)}</script>
<script>${markedBrowserScript()}</script>
<script>
function escapePromptHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safePromptUrl(value) {
  const href = String(value || "").trim().replace(/[\\x00-\\x1f\\x7f]/g, "");
  const scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  return scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1]) ? null : href;
}
marked.use({
  gfm: true,
  breaks: true,
  tokenizer: { html() { return undefined; }, tag() { return undefined; } },
  renderer: {
    html(token) { return escapePromptHtml(token.raw || token.text || ""); },
    link(token) {
      const href = safePromptUrl(token.href);
      const text = this.parser.parseInline(token.tokens || []);
      return href ? '<a href="' + escapePromptHtml(href) +
        '" target="_blank" rel="noopener noreferrer">' + text + '</a>' : text;
    },
    image(token) {
      const href = safePromptUrl(token.href);
      return href ? '<img src="' + escapePromptHtml(href) + '" alt="' +
        escapePromptHtml(token.text || "") + '">' : escapePromptHtml(token.text || "");
    },
    code(token) { return "<pre><code>" + escapePromptHtml(token.text) + "</code></pre>"; },
    codespan(token) { return "<code>" + escapePromptHtml(token.text) + "</code>"; },
  },
});
document.getElementById("prompt").innerHTML = marked.parse(
  document.getElementById("prompt-source").textContent || "",
);
</script>`;
}

function wsAccept(key: string): string {
  return createHash("sha1").update(key + WS_MAGIC).digest("base64");
}

function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function readWsFrame(
  buf: Buffer,
): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0]! & 0x0f;
  const masked = (buf[1]! & 0x80) !== 0;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const n = buf.readBigUInt64BE(2);
    if (n > BigInt(MAX_WS_PAYLOAD)) {
      return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) };
    }
    len = Number(n);
    offset = 10;
  }
  if (len > MAX_WS_PAYLOAD) {
    return { opcode: 8, payload: Buffer.alloc(0), rest: Buffer.alloc(0) };
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]!;
  }
  return { opcode, payload, rest: buf.subarray(offset + maskLen + len) };
}

function acceptWebSocket(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  onMessage: (text: string) => void,
  onClose: () => void,
): Client | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
    socket.destroy();
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      "\r\n",
  );
  let buf = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      socket.write(encodeWsFrame(8, Buffer.alloc(0)));
    } catch {
      // ignore
    }
    socket.destroy();
    onClose();
  };
  const sendRaw = (payload: Buffer, opcode = 1) => {
    if (closed) return;
    socket.write(encodeWsFrame(opcode, payload));
  };
  const consume = () => {
    while (true) {
      const frame = readWsFrame(buf);
      if (!frame) break;
      buf = frame.rest;
      if (frame.opcode === 8) {
        close();
        return;
      }
      if (frame.opcode === 9) {
        sendRaw(frame.payload, 10);
        continue;
      }
      if (frame.opcode === 1) onMessage(frame.payload.toString("utf8"));
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    consume();
  });
  socket.on("close", close);
  socket.on("end", close);
  socket.on("error", close);
  consume();
  return {
    send(obj: unknown) {
      sendRaw(Buffer.from(JSON.stringify(obj), "utf8"));
    },
    close,
  };
}

export default function piFwd(pi: ExtensionAPI) {
  let server: http.Server | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let editorTimer: ReturnType<typeof setInterval> | undefined;
  let id: string | undefined;
  let cwd = "";
  let closing = false;
  let uiCtx: ExtensionContext | undefined;
  let listenPort: number | undefined;
  let lastFooterJson = "";
  let assistantStreamCounter = 0;
  let assistantStreamId: string | undefined;
  let assistantStreamText = "";
  let assistantStreamStartedAt: number | undefined;
  const assistantThinking = new ThinkingAccumulator();
  let lastOutputFirstLine = "";
  let fallbackPrompt = "";
  const clients = new Set<Client>();
  const liveToolCallIds = new Set<string>();
  const toolComponents = new Map<string, {
    component: ToolExecutionComponent;
    toolName: string;
    isError: boolean;
    status: ToolRunStatus;
    args: unknown;
    result?: unknown;
    startedAt: number;
    completedAt?: number;
  }>();
  broadcastEditor = () => {
    pushComposer();
  };
  const builtins = loadBuiltinSlashCommands();

  function broadcast(obj: unknown): void {
    for (const client of [...clients]) {
      try {
        client.send(obj);
      } catch {
        clients.delete(client);
        try {
          client.close();
        } catch {
          // ignore
        }
      }
    }
  }

  function emitEvent(kind: string, extra: Record<string, unknown> = {}): void {
    broadcast({ type: "event", event: kind, ...extra });
  }

  function publishThinking(completedAt?: number, target?: Client): void {
    if (!assistantStreamId) return;
    const text = assistantThinking.text();
    if (!text) return;
    const message = {
      type: "event",
      event: "thinking_update",
      id: assistantStreamId,
      text,
      startedAt: assistantStreamStartedAt,
      completedAt,
    };
    if (target) target.send(message);
    else broadcast(message);
  }

  function fallbackSessionTitle(): string {
    const line = fallbackPrompt.split(/\r?\n/).find((value) => value.trim())?.trim() ?? "";
    return (line || fallbackPrompt.trim() || "New session").slice(0, 80);
  }

  function sessionTitle(): string {
    try {
      const named = pi.getSessionName()?.trim();
      if (named) return named.slice(0, 200);
    } catch {
      // Session runtime is not bound yet.
    }
    return fallbackSessionTitle();
  }

  function publishSessionTitle(target?: Client): void {
    const message = { type: "session-title", title: sessionTitle() };
    if (target) target.send(message);
    else broadcast(message);
  }

  function fileToolBodyHtml(body: FileToolBody): string {
    const rows = body.rows.map((row) => {
      const kind = escapeHtml(row.kind);
      return `<div class="file-tool-row ${kind}">` +
        `<span class="file-tool-marker">${escapeHtml(row.marker ?? "")}</span>` +
        `<span class="file-tool-line">${escapeHtml(row.line ?? "")}</span>` +
        `<span class="file-tool-text">${escapeHtml(row.text)}</span>` +
        "</div>";
    }).join("");
    const more = body.hiddenRows > 0
      ? `<div class="file-tool-more">${body.hiddenRows} more lines · expand to show more</div>`
      : "";
    return `<div class="file-tool-body">${rows}${more}</div>`;
  }

  function ensureToolComponent(
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): {
    component: ToolExecutionComponent;
    toolName: string;
    isError: boolean;
    status: ToolRunStatus;
    args: unknown;
    result?: unknown;
    startedAt: number;
    completedAt?: number;
  } {
    const existing = toolComponents.get(toolCallId);
    if (existing) {
      if (args && typeof args === "object" && Object.keys(args as object).length > 0) {
        existing.args = args;
      }
      return existing;
    }
    const definition = (
      live.__piFwdToolDefinitions?.get(toolName) ??
      live.__piFwdMode?.getRegisteredToolDefinition?.(toolName) ??
      loadBuiltinToolRenderers(toolName, cwd)
    ) as ConstructorParameters<typeof ToolExecutionComponent>[4];
    const ui = (live.__piFwdTui ?? { requestRender() {} }) as ConstructorParameters<
      typeof ToolExecutionComponent
    >[5];
    const state = {
      component: new ToolExecutionComponent(
        toolName,
        toolCallId,
        args,
        {},
        definition,
        ui,
        cwd,
      ),
      toolName,
      isError: false,
      status: "running" as const,
      args,
      startedAt: Date.now(),
    };
    state.component.markExecutionStarted();
    state.component.setArgsComplete();
    state.component.setExpanded(toolWebPresentation(toolName, args).expanded);
    toolComponents.set(toolCallId, state);
    return state;
  }

  function publishTool(toolCallId: string, target?: Client): void {
    const state = toolComponents.get(toolCallId);
    if (!state) return;
    const recipients = target ? [target] : [...clients];
    for (const client of recipients) {
      let disclosure = clientToolExpanded.get(client);
      if (!disclosure) {
        disclosure = new Map();
        clientToolExpanded.set(client, disclosure);
      }
      const presentation = toolWebPresentation(state.toolName, state.args);
      const expanded = disclosure.get(toolCallId) ??
        defaultToolExpanded(state.toolName, state.args, clientMobile.get(client) === true);
      if (state.toolName === "subagent") {
        client.send({
          type: "subagent-item",
          id: `tool:${toolCallId}`,
          expanded,
          toolStatus: state.status,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
          ...subagentWebData(state.args, state.result, state.isError, state.startedAt),
        });
        continue;
      }
      const fileBody = fileToolBody(
        state.toolName,
        state.args,
        state.result,
        state.isError,
        expanded,
      );
      if (fileBody) {
        client.send({
          type: "file-tool-item",
          id: `tool:${toolCallId}`,
          title: presentation.title,
          toolKind: state.toolName,
          html: fileToolBodyHtml(fileBody),
          isError: state.isError,
          status: state.status,
          expanded,
          startedAt: state.startedAt,
          completedAt: state.completedAt,
        });
        continue;
      }
      const cols = clientCols.get(client) ?? 80;
      state.component.setExpanded(expanded);
      const rawLines = state.component.render(cols);
      while (rawLines.length > 0 && !stripAnsi(rawLines[0]).trim()) rawLines.shift();
      while (rawLines.length > 0 && !stripAnsi(rawLines[rawLines.length - 1]).trim()) rawLines.pop();
      const lines = rawLines.map(stripAnsi);
      client.send({
        type: "tty-item",
        id: `tool:${toolCallId}`,
        title: presentation.title,
        toolKind: state.toolName,
        lines,
        html: ansiLinesHtml(rawLines),
        isError: state.isError,
        status: state.status,
        expanded,
        startedAt: state.startedAt,
        completedAt: state.completedAt,
      });
    }
  }

  function interruptRunningTools(target?: Client, completedAt?: number): void {
    for (const [toolCallId, state] of toolComponents) {
      const status = transitionToolStatus(state.status, "interrupt");
      if (status === state.status) continue;
      state.status = status;
      state.completedAt = completedAt;
      liveToolCallIds.delete(toolCallId);
      publishTool(toolCallId, target);
    }
  }

  function commandList(): SlashCmd[] {
    const seen = new Set<string>();
    const out: SlashCmd[] = [];
    for (const cmd of builtins) {
      if (!cmd?.name || seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push({
        name: cmd.name,
        description: cmd.description,
        argumentHint: cmd.argumentHint,
      });
    }
    try {
      for (const cmd of pi.getCommands()) {
        if (!cmd?.name || seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        out.push({ name: cmd.name, description: cmd.description });
      }
    } catch {
      // session not bound yet
    }
    return out;
  }

  function tuiUi(): {
    getFocusedComponent?: () => { handleInput?: (data: string) => void } | null;
    requestRender?: () => void;
    handleTerminalInput?: (data: string) => void;
  } | undefined {
    const host = submitHost as
      | {
          ui?: {
            getFocusedComponent?: () => { handleInput?: (data: string) => void } | null;
            requestRender?: () => void;
            handleTerminalInput?: (data: string) => void;
          };
        }
      | undefined;
    return live.__piFwdTui ?? host?.ui;
  }

  function publishComposer(target?: Client): void {
    const ed = live.__piFwdEditor;
    const orig = (Editor.prototype as unknown as { __piFwdOrigRender?: (width: number) => string[] }).__piFwdOrigRender;
    const cols = target ? (clientCols.get(target) ?? 80) : 80;
    const focused = live.__piFwdTui?.getFocusedComponent?.() as
      | { render?: (width: number) => string[] }
      | null
      | undefined;
    const container = live.__piFwdMode?.editorContainer;
    let rawLines: string[] = [];
    live.__piFwdPainting = true;
    try {
      if (focused?.render) {
        rawLines = focused.render(cols);
      } else if (container?.render) {
        rawLines = container.render(cols);
      } else if (ed && orig) {
        rawLines = orig.call(ed, cols);
      }
    } finally {
      live.__piFwdPainting = false;
    }
    if (rawLines.length === 0) return;
    let cursor: { line: number; col: number } | undefined;
    const lines: string[] = [];
    for (const raw of rawLines) {
      let idx = raw.indexOf(CURSOR_MARKER);
      if (idx < 0) idx = raw.indexOf("\x1b_pi:c");
      const cleaned =
        idx >= 0
          ? raw.slice(0, idx) + raw.slice(idx + (idx === raw.indexOf(CURSOR_MARKER) ? CURSOR_MARKER.length : 6))
          : raw;
      const text = stripAnsi(cleaned);
      // TUI components use horizontal rules as top/bottom chrome. The browser
      // already has its own border, so retaining them wastes two phone rows.
      if (/^\s*[-_=─━═╌╍┄┅┈┉]{3,}\s*$/.test(text)) continue;
      if (idx >= 0 && cursor === undefined) {
        cursor = { line: lines.length, col: stripAnsi(raw.slice(0, idx)).length };
      }
      lines.push(text);
    }
    if (lines.length === 0) lines.push("");
    if (!cursor && ed?.getCursor) {
      const c = ed.getCursor();
      const rowText = ed.getLines?.()[c.line] ?? ed.getText?.().split("\n")[c.line] ?? "";
      if (rowText) {
        for (let i = 0; i < lines.length; i++) {
          const pos = lines[i].indexOf(rowText);
          if (pos >= 0) {
            cursor = { line: i, col: pos + c.col };
            break;
          }
        }
      }
      if (!cursor && lines.length > 0) {
        const inner = lines.length >= 3 ? 1 : 0;
        cursor = { line: inner, col: c.col };
      }
    }
    if (target) {
      target.send({ type: "composer", lines, cursor });
      return;
    }
    for (const client of clients) publishComposer(client);
  }
  live.__piFwdOnPaint = publishComposer;

  function publishFooter(rawLines: string[]): void {
    const lines = rawLines.map(stripAnsi);
    const encoded = JSON.stringify(lines);
    if (encoded === lastFooterJson) return;
    lastFooterJson = encoded;
    broadcast({ type: "footer", lines });
  }
  live.__piFwdOnFooter = publishFooter;

  function pushComposer(): void {
    const host = submitHost as {
      editorContainer?: { render: (width: number) => string[] };
      editor?: { render: (width: number) => string[] };
    };
    const box =
      host?.editorContainer ??
      live.__piFwdEditor ??
      host?.editor;
    publishComposer();
  }

  async function handleClientMessage(client: Client, raw: string): Promise<void> {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (msg.type === "set-session-title" && typeof msg.title === "string") {
      const title = msg.title.replace(/\s+/g, " ").trim().slice(0, 200);
      pi.setSessionName(title);
      publishSessionTitle();
      if (listenPort) void heartbeat(listenPort);
      return;
    }
    if (msg.type === "visibility" && typeof msg.visible === "boolean") {
      clientVisible.set(client, msg.visible);
      return;
    }
    if (msg.type === "size" && typeof msg.cols === "number" && Number.isFinite(msg.cols)) {
      clientCols.set(client, Math.max(20, Math.min(240, Math.floor(msg.cols))));
      if (typeof msg.mobile === "boolean") clientMobile.set(client, msg.mobile);
      publishComposer(client);
      for (const toolCallId of toolComponents.keys()) publishTool(toolCallId, client);
      return;
    }
    if (
      msg.type === "tool-expanded" &&
      typeof msg.toolCallId === "string" &&
      typeof msg.expanded === "boolean"
    ) {
      const state = toolComponents.get(msg.toolCallId);
      if (state) {
        let disclosure = clientToolExpanded.get(client);
        if (!disclosure) {
          disclosure = new Map();
          clientToolExpanded.set(client, disclosure);
        }
        disclosure.set(msg.toolCallId, msg.expanded);
        publishTool(msg.toolCallId, client);
      }
      return;
    }
    if (msg.type !== "key" || typeof msg.data !== "string") return;
    const ui = tuiUi();
    if (ui?.handleTerminalInput) {
      ui.handleTerminalInput(msg.data);
      publishComposer();
      return;
    }
    const focus =
      ui?.getFocusedComponent?.() ??
      live.__piFwdEditor ??
      (submitHost as { editor?: { handleInput?: (data: string) => void } }).editor;
    focus?.handleInput?.(msg.data);
    live.__piFwdTui?.requestRender?.();
  }

  function attachClient(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    let client: Client | null = null;
    client = acceptWebSocket(
      req,
      socket,
      head,
      (text) => {
        if (client) void handleClientMessage(client, text);
      },
      () => {
        if (client) clients.delete(client);
      },
    );
    if (!client) return;
    clients.add(client);
    hydrateClient(client);
  }

  function hydrateClient(client: Client): void {
    try {
      const messages = uiCtx?.sessionManager.buildSessionProjection()?.messages ?? [];
      const resultIds = new Set(
        messages
          .filter((message) => (message as { role?: string }).role === "toolResult")
          .map((message) => (message as { toolCallId?: unknown }).toolCallId)
          .filter((toolCallId): toolCallId is string => typeof toolCallId === "string"),
      );
      const canIdentifyLiveTools = uiCtx?.isIdle() === true || liveToolCallIds.size > 0;
      if (!fallbackPrompt) {
        const firstUser = messages.find((message) => (message as { role?: string }).role === "user");
        if (firstUser) fallbackPrompt = semanticMessageText(firstUser);
      }
      for (const message of messages) {
        if ((message as { role?: string }).role !== "assistant") continue;
        const content = (message as { content?: unknown }).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (!block || typeof block !== "object") continue;
          const rec = block as Record<string, unknown>;
          if (
            rec.type === "toolCall" &&
            typeof rec.id === "string" &&
            typeof rec.name === "string"
          ) {
            const state = ensureToolComponent(rec.id, rec.name, rec.arguments ?? {});
            const timestamp = (message as { timestamp?: unknown }).timestamp;
            if (typeof timestamp === "number") state.startedAt = timestamp;
            else if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) {
              state.startedAt = Date.parse(timestamp);
            }
            if (
              canIdentifyLiveTools &&
              !resultIds.has(rec.id) &&
              !liveToolCallIds.has(rec.id)
            ) {
              state.status = transitionToolStatus(state.status, "interrupt");
            }
          }
        }
      }
      let historyAssistantIndex = 0;
      for (const message of messages) {
        const role = (message as { role?: string }).role;
        if (!role || role === "system") continue;
        if (role === "toolResult") {
          const result = message as {
            toolCallId?: string;
            toolName?: string;
            content?: unknown;
            details?: unknown;
            isError?: boolean;
          };
          if (result.toolCallId && result.toolName) {
            const state = ensureToolComponent(result.toolCallId, result.toolName, {});
            state.isError = result.isError === true;
            state.status = transitionToolStatus(state.status, "complete");
            const timestamp = (message as { timestamp?: unknown }).timestamp;
            if (typeof timestamp === "number") state.completedAt = timestamp;
            else if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) {
              state.completedAt = Date.parse(timestamp);
            }
            const hydratedResult = {
              content: Array.isArray(result.content) ? result.content : [],
              details: result.details,
              isError: state.isError,
            };
            state.result = hydratedResult;
            state.component.updateResult(hydratedResult, false);
            publishTool(result.toolCallId, client);
          }
          continue;
        }
        const historyId = role === "assistant"
          ? `history-${++historyAssistantIndex}`
          : undefined;
        if (role === "assistant") {
          const thinking = thinkingBlocksFromMessage(message)
            .map((block) => block.text)
            .join("\n\n");
          if (thinking) {
            client.send({
              type: "event",
              event: "thinking_update",
              id: historyId,
              text: thinking,
              startedAt: (message as { timestamp?: unknown }).timestamp,
              completedAt: (message as { timestamp?: unknown }).timestamp,
            });
          }
        }
        client.send({
          type: "event",
          event: "history",
          role,
          id: historyId,
          text: semanticMessageText(message),
          timestamp: (message as { timestamp?: unknown }).timestamp,
        });
        if (role === "assistant") {
          const content = (message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (!block || typeof block !== "object") continue;
              const rec = block as Record<string, unknown>;
              if (rec.type === "toolCall" && typeof rec.id === "string") {
                publishTool(rec.id, client);
              }
            }
          }
        }
      }
    } catch {
      // session manager not ready
    }
    lastFooterJson = "";
    if (assistantStreamId && assistantStreamText) {
      client.send({
        type: "event",
        event: "message_update",
        role: "assistant",
        id: assistantStreamId,
        text: assistantStreamText,
        startedAt: assistantStreamStartedAt,
      });
    }
    publishThinking(undefined, client);
    publishSessionTitle(client);
    publishComposer(client);
  }

  async function register(port: number): Promise<void> {
    if (!id) return;
    const repository = repositoryMetadata(cwd);
    const res = await fetch(`${hubBase()}/general/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        pid: process.pid,
        port,
        cwd,
        sessionTitle: sessionTitle(),
        ...repository,
        protocolVersion: PROTOCOL_VERSION,
        pluginRevision: PLUGIN_REVISION,
        uiEntry: "/",
      }),
    });
    if (!res.ok) throw new Error(`register ${res.status}`);
  }

  async function heartbeat(port: number): Promise<void> {
    if (!id || closing) return;
    try {
      // Refresh the complete row, not only its TTL. This lets a newer plugin
      // revision repair stale ports and metadata left by an older reload.
      await register(port);
    } catch {
      // hub down
    }
  }

  async function notifyPush(): Promise<void> {
    if (!id || [...clients].some((client) => clientVisible.get(client) === true)) return;
    try {
      await fetch(`${hubBase()}/general/push/notify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id, firstLine: lastOutputFirstLine }),
      });
    } catch {
      // Optional notification path; never affect the Pi turn.
    }
  }

  async function stop(): Promise<void> {
    if (closing && !server && !timer && !editorTimer && !id && clients.size === 0) return;
    closing = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (editorTimer) {
      clearInterval(editorTimer);
      editorTimer = undefined;
    }
    uiCtx = undefined;
    lastEditor = "";
    assistantStreamId = undefined;
    assistantStreamText = "";
    assistantStreamStartedAt = undefined;
    assistantThinking.clear();
    fallbackPrompt = "";
    listenPort = undefined;
    for (const client of [...clients]) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    clients.clear();
    const currentId = id;
    id = undefined;
    const current = server;
    server = undefined;
    if (current) {
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
    }
    if (currentId) {
      try {
        await fetch(`${hubBase()}/general/sessions/${encodeURIComponent(currentId)}`, {
          method: "DELETE",
        });
      } catch {
        // hub down
      }
    }
    closing = false;
  }

  pi.on("message_start", (event) => {
    const role = (event.message as { role?: string } | undefined)?.role;
    const timestamp = (event.message as { timestamp?: unknown } | undefined)?.timestamp;
    const startedAt = typeof timestamp === "number" ? timestamp : Date.now();
    if (role === "user") {
      lastOutputFirstLine = "";
      if (!fallbackPrompt) {
        fallbackPrompt = semanticMessageText(event.message);
        publishSessionTitle();
        if (listenPort) void heartbeat(listenPort);
      }
    }
    if (role === "assistant") {
      assistantStreamId = `${Date.now()}-${++assistantStreamCounter}`;
      assistantStreamText = semanticMessageText(event.message);
      assistantStreamStartedAt = startedAt;
      assistantThinking.replaceFromMessage(event.message);
    }
    emitEvent("message_start", {
      role,
      id: role === "assistant" ? assistantStreamId : undefined,
      text: semanticMessageText(event.message),
      startedAt,
    });
  });
  pi.on("message_update", (event) => {
    if (!assistantStreamId) {
      assistantStreamId = `${Date.now()}-${++assistantStreamCounter}`;
      assistantStreamText = "";
    }
    const update = event.assistantMessageEvent;
    if (update.type === "thinking_start") {
      assistantThinking.set(update.contentIndex, "");
    } else if (update.type === "thinking_delta") {
      assistantThinking.append(update.contentIndex, update.delta);
      publishThinking();
    } else if (update.type === "thinking_end") {
      assistantThinking.set(update.contentIndex, update.content);
      publishThinking();
    } else if (update.type === "text_delta") {
      assistantStreamText += update.delta;
      emitEvent("message_update", {
        role: "assistant",
        id: assistantStreamId,
        delta: update.delta,
        startedAt: assistantStreamStartedAt,
      });
    } else if (update.type === "text_end") {
      const authoritative = semanticMessageText(event.message);
      if (authoritative !== assistantStreamText) {
        assistantStreamText = authoritative;
        emitEvent("message_update", {
          role: "assistant",
          id: assistantStreamId,
          text: assistantStreamText,
          startedAt: assistantStreamStartedAt,
        });
      }
    }
  });
  pi.on("message_end", (event) => {
    const role = (event.message as { role?: string } | undefined)?.role;
    const streamId = role === "assistant" ? assistantStreamId : undefined;
    const text = semanticMessageText(event.message);
    if (role === "assistant") {
      assistantThinking.replaceFromMessage(event.message);
      publishThinking(Date.now());
      const firstLine = notificationFirstLine(text);
      if (firstLine) lastOutputFirstLine = firstLine;
    }
    emitEvent("message_end", {
      role,
      id: streamId,
      text,
      completedAt: Date.now(),
    });
    if (role === "assistant") {
      assistantStreamId = undefined;
      assistantStreamText = "";
      assistantStreamStartedAt = undefined;
      assistantThinking.clear();
    }
  });
  pi.on("tool_execution_start", (event) => {
    liveToolCallIds.add(event.toolCallId);
    ensureToolComponent(event.toolCallId, event.toolName, event.args);
    publishTool(event.toolCallId);
  });
  pi.on("tool_execution_update", (event) => {
    const state = ensureToolComponent(event.toolCallId, event.toolName, {});
    const partial = event.partialResult && typeof event.partialResult === "object"
      ? { ...event.partialResult, isError: false }
      : {
          content: [{ type: "text", text: String(event.partialResult ?? "") }],
          isError: false,
        };
    state.result = partial;
    state.component.updateResult(partial, true);
    publishTool(event.toolCallId);
  });
  pi.on("tool_execution_end", (event) => {
    liveToolCallIds.delete(event.toolCallId);
    const state = ensureToolComponent(event.toolCallId, event.toolName, {});
    state.isError = event.isError;
    state.status = transitionToolStatus(state.status, "complete");
    const result = event.result && typeof event.result === "object"
      ? { ...event.result, isError: event.isError }
      : { content: [{ type: "text", text: String(event.result ?? "") }], isError: event.isError };
    state.result = result;
    state.completedAt = Date.now();
    state.component.updateResult(result, false);
    const resultText = semanticMessageText(result);
    if (resultText.trim()) lastOutputFirstLine = notificationFirstLine(resultText);
    publishTool(event.toolCallId);
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome !== "completed") interruptRunningTools(undefined, Date.now());
  });
  pi.on("agent_settled", () => {
    interruptRunningTools(undefined, Date.now());
    emitEvent("agent_settled");
    void notifyPush();
  });
  pi.on("session_info_changed", () => {
    publishSessionTitle();
    if (listenPort) void heartbeat(listenPort);
  });

  pi.on("session_start", async (event, ctx) => {
    extLog(`session_start mode=${ctx.mode} reason=${event.reason}`);
    if (ctx.mode !== "tui") return;
    try {
    cwd = ctx.cwd;
    id = resolveId(ctx);
    uiCtx = ctx;
    lastEditor = "";
    fallbackPrompt = "";
    try {
      const messages = ctx.sessionManager.buildSessionProjection()?.messages ?? [];
      const firstUser = messages.find((message) => (message as { role?: string }).role === "user");
      if (firstUser) fallbackPrompt = semanticMessageText(firstUser);
    } catch {
      // A new session may not have a projection yet.
    }
    if (server && listenPort) {
      broadcast({ type: "reset", reason: event.reason });
      broadcast({ type: "editor", text: "", from: "cli" });
      try {
        await register(listenPort);
      } catch {
        // hub down
      }
      return;
    }
    closing = false;
    const pid = process.pid;
    const created = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        url.pathname === "/system-prompt"
      ) {
        let promptText = "";
        try {
          promptText = uiCtx?.getSystemPrompt() ?? "";
        } catch {
          promptText = "";
        }
        const body = systemPromptPage(promptText || "System prompt is not available yet.", sessionTitle());
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      if (
        (req.method === "GET" || req.method === "HEAD") &&
        (url.pathname === "/" || url.pathname === "")
      ) {
        const body = sessionPage(cwd, pid, sessionTitle());
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : body);
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\n");
    });
    created.maxConnections = 32;
    created.headersTimeout = 10_000;
    created.requestTimeout = 30_000;
    created.keepAliveTimeout = 5_000;
    created.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/" && url.pathname !== "") {
        socket.destroy();
        return;
      }
      attachClient(req, socket, head);
    });
    server = created;
    let selectedPort: number;
    try {
      selectedPort = await listenOnAgentPort(created, AGENT_LISTEN_HOST, AGENT_SERIES_START);
    } catch (error) {
      extLog(`listen error ${error instanceof Error ? error.message : String(error)}`);
      server = undefined;
      id = undefined;
      uiCtx = undefined;
      return;
    }
    listenPort = selectedPort;
    try {
      await register(selectedPort);
    } catch {
      // hub may be down; heartbeat retries
    }
    timer = setInterval(() => {
      void heartbeat(selectedPort);
    }, HEARTBEAT_MS);
    pushComposer();
    extLog(`listening port=${listenPort} id=${id}`);
    } catch (err) {
      extLog(`session_start error ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (event.reason === "new" || event.reason === "fork" || event.reason === "resume") {
      broadcast({ type: "reset", reason: event.reason });
    }
    await stop();
  });
}
