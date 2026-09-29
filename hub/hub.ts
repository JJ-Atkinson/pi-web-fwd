import http from "node:http";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseHubAddress } from "./net.ts";

const HUB_ADDRESS = parseHubAddress(process.env.PI_FWD_HUB_ADDR);
const HOST = HUB_ADDRESS.host;
const PORT = HUB_ADDRESS.port;
const HUB_ORIGIN = `http://${HOST.includes(":") ? `[${HOST}]` : HOST}:${PORT}`;
const TTL_MS = 45_000;
const SWEEP_MS = 5_000;
const MAX_BODY_BYTES = 256 * 1024;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;
const PUSH_STATE_PATH = process.env.PI_FWD_PUSH_STATE ??
  join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "pi-fwd/push-state.json");
const VAPID_SUBJECT = process.env.PI_FWD_VAPID_SUBJECT ??
  "mailto:pi-fwd@example.com";
const webPush = createRequire(import.meta.url)("web-push") as {
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: PushSubscription,
    payload: string,
    options?: {
      TTL?: number;
      urgency?: string;
      vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    },
  ): Promise<unknown>;
};
const ICON_192 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAACS0lEQVR42u3Z0QmFMBQFwVSRJu3IeuxLv9JAEBR2PraBy5ng44055y1VG44gACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQAJAAkACQA/tFxne4AQHP4K/cAIDt+AABIjx8AALLDBwCA/PgBACA9fgAAyA4fAADy4wcAgOzwAQAgP34AAEiPHwAAssM3fgC8+gLAqy8AjF8A+OQRAF59AWD8AsDwBYDxCwA/dAWAV18AGL8A8MkjALz6AsCrLwC8+gLA+AWATx4B4NVXGoDhKwvA+AWA8QsAwxcAxi8AjF8AGL4AgEAAQCAAIBAAIAAAAAQAAAACABBAAAAIEAAAAQgAQAABACCAAAAEEAAAAgQAQAACABBAAAAIEAAAAQgAgAABABCAAAAEEAAAAgQAQAACACBAAAAEIAAAAQQAgAABABBAAAAEAAAAAgAAQAAAACC4FQBpBO4EQBqBGwGQhuA2AKQRvP0P8xcBoG0IAACQRgAAAGkEAAAgAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASAAHAEASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgASABIAEgbfYA8zUFSeefKWgAAAAASUVORK5CYII=",
  "base64",
);
const ICON_512 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAJtElEQVR42u3d0W2EQBAFwY1ikiQj4iEvSGKFEF0flcDsSa8l2+c1MzcA0LIcAQAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIA2Om4TncAAQDUxl8AgAAAYsMvAEAAOAREx18AgAAAguMvAEAAALHhFwAgABwCouMvAEAAALHhFwAgABwCouMvAEAAAMHxFwAgAIDY8AsAEAAOAdHxFwAgAIDY8AsAEAAOAdHxFwAgAIDg+AsAEABAbPgFAAgAh4Do+AsAEABAcPwFAAgAIDb8AgAEgENAdPwFAAgAIDb8AgAEgENAdPwFAAgAIDj+AgAEABAbfgEAAsAhIDr+AgAEABAbfgEAAsAhIDr+AgAEABAcfwEAAgCIDb8AAAHgEBAdfwEAAgCIDb8AAAHgEBAdfwEAAgAIjr8AAAEAxIZfAIAAcAiIjr8AAAEABMdfAIAAAGLDb/xBADgEGH9AAACGHxAAgPEHBAAYf+MPCAAw/IYfEABg/I0/IADA8Bt+QACA8Tf+gAAA42/8AQEAht/wAwIAjL/xBwQAGH7DDwgAMP4AAgCMP4AAAMMPIAAw/sYfQABg/I0/IAAcAcNv+AEBAMbf+AMCAAy/4QcEABh/4w8IADD+xh8QAGD4DT8gAMD4G39AAIDhN/yAAADjDyAAwPgDCAAw/AACAONv/AEEAIbf8AMIAIy/8QcQABh/4w8gADD8hh9AAGD8jT+AAMD4G39AAIDhN/yAAADjb/wBAQCGH0AAgPEHEABg/AEEAIbf8AMIAIy/8QcQABh+ww8gADD+xh9AAGD8jT+AAMDwG34AAYDxN/4AAgDDb/gBBAACwPgDCAAEgPEHEAAkA8DbAQgAYgHg3QAEALEA8GYAAoBQAHgrAAFALAC8E4AAIBQA3gdAABALAG8DIACIBYB3ARAAhALAewAIAGIB4C0ABAChAPAGAAKAWAC4P4AAIBYAbg8gAAgFgJsDCABiAeDeAAKAUAC4M4AAQAAAIADwIwAABAB+CRAAAYA/AwRAAPCjABABAAKAaACIAAABQDQAhACAACAcACIAQAAQDQAhACAACAeACAAQAEQDQAQACACiASAEAAQA4QAQAQACgGgAiAAAAUA0AIQAgAAgHAAiAEAAEA0AIQAgAAgHgAgAEABEA0AEAAgAhACAAAARACAAQAgACAAQAQACAEQAgAAAIQAgABABIgBAACAEhACAAEAEiAAAAYAIEAEAAgAhIAQABAAiQAQACABEgAgAEAAIASEAIAAQASIAQAAgBIQAgABABIgAAAGACBABgAAAISAEAAEAIkAEAAIAhIAQAAQAiAARAAgAEAEiABAAIASEACAAQASIAEAAgBAQAoAAABEgAgABACLAWwICAIQAgAAAEQAgAEAEAAgAEAIAAgBEAIAAACEAIAAQASIAEACOgAgQAYAAACEgBAABACJABAACAISAEAAEAIgAEQAIABABIgAQACAEhAAgAEAEiABAAIAQEAKAAAARIAIAAQAiQAQAAgCEgBAABACIABEACAAQASIAEAAgBAQAIABABAgAQACAEBAAgACAeAR4MxAAQDACvBcIACAYAt4JBAAQjABvBAIACIaAtwEBAAQjwLuAAACCEeBNQAAAwRDwFiAAgGAEeAcQAEAwBNwfBAAQjAC3BwEABCPA3UEAAMEQcG8QAEAwAtwaBAAQjAB3BgEABEPAfUEAAMEIcFsQAEAwBNwUBAAQjAD3BAEABCPALUEAAMEQcEMQAEAwAr72vQT4B1EIAOCFEBAACAABAAQjQAAgAAQAEIwAAYAAEABAMAQEAAJAAADBCBAACAABAARDQAAgAAQAEIwAAYAAEABAMAIEAAJAAADBEBAACAABAAQjQAAgAAQAgADA510AAAgAAYAAAAQAAgABAAgABAACABAACAAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAEAAIAAQAIAAQAAgAQAAgABAAgABAACABAACAAEACAAEAAIAAAAYAAEAAAAgABIAAABIAAQAAAAsAwCgAEACAAEAAIAEAAIAAQAIAAQAAgAAABgABAAAACAAGAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAAAsARAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAIAEcAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAAAEAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAAAQAABDxAGHVyWgvPyN6AAAAAElFTkSuQmCC",
  "base64",
);

type SessionRow = {
  id: string;
  pid: number;
  port: number;
  cwd: string;
  sessionTitle: string;
  repoRoot: string;
  repoName: string;
  protocolVersion: number;
  pluginRevision: string;
  uiEntry: string;
  lastHeartbeat: number;
};

type PushSubscription = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  vapidSubject?: string;
};

type PushState = {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: PushSubscription[];
};

const sessions = new Map<string, SessionRow>();

function loadPushState(): PushState {
  try {
    const parsed = JSON.parse(readFileSync(PUSH_STATE_PATH, "utf8")) as Partial<PushState>;
    if (
      parsed.vapid?.publicKey &&
      parsed.vapid.privateKey &&
      Array.isArray(parsed.subscriptions)
    ) {
      return {
        vapid: parsed.vapid,
        subscriptions: parsed.subscriptions.filter(validPushSubscription),
      };
    }
  } catch {
    // First run or invalid state: replace it below.
  }
  return { vapid: webPush.generateVAPIDKeys(), subscriptions: [] };
}

function validPushSubscription(value: unknown): value is PushSubscription {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  const keys = rec.keys as Record<string, unknown> | undefined;
  if (
    typeof rec.endpoint !== "string" ||
    !rec.endpoint.startsWith("https://") ||
    rec.endpoint.length > 4096 ||
    typeof keys?.p256dh !== "string" ||
    typeof keys.auth !== "string"
  ) return false;
  return keys.p256dh.length <= 1024 && keys.auth.length <= 1024;
}

function httpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

let pushState = loadPushState();
function savePushState(): void {
  mkdirSync(dirname(PUSH_STATE_PATH), { recursive: true });
  const temp = `${PUSH_STATE_PATH}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(pushState, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, PUSH_STATE_PATH);
}
savePushState();
webPush.setVapidDetails(
  VAPID_SUBJECT,
  pushState.vapid.publicKey,
  pushState.vapid.privateKey,
);

async function sendPush(payload: Record<string, unknown>): Promise<void> {
  const stale = new Set<string>();
  await Promise.all(pushState.subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification(subscription, JSON.stringify(payload), {
        TTL: 120,
        urgency: "high",
        vapidDetails: {
          subject: subscription.vapidSubject ?? VAPID_SUBJECT,
          publicKey: pushState.vapid.publicKey,
          privateKey: pushState.vapid.privateKey,
        },
      });
    } catch (error) {
      const status = Number((error as { statusCode?: unknown }).statusCode);
      if (status === 404 || status === 410) stale.add(subscription.endpoint);
      else {
        const detail = error as { statusCode?: unknown; body?: unknown };
        log(
          `push failed status=${String(detail.statusCode ?? "?")} ` +
          `body=${String(detail.body ?? "")} ` +
          `message=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }));
  if (stale.size > 0) {
    pushState = {
      ...pushState,
      subscriptions: pushState.subscriptions.filter((item) => !stale.has(item.endpoint)),
    };
    savePushState();
  }
}


function log(msg: string): void {
  process.stdout.write(`pi-fwd: ${msg}\n`);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sweep(): void {
  const now = Date.now();
  for (const [id, row] of sessions) {
    // Heartbeat only. kill(pid,0) is wrong when Pi is in locksh (guest pid).
    if (now - row.lastHeartbeat > TTL_MS) {
      sessions.delete(id);
      log(`drop ${id} (ttl)`);
    }
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function staticBody(
  res: http.ServerResponse,
  contentType: string,
  body: string | Buffer,
  extraHeaders: Record<string, string> = {},
  headOnly = false,
): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(headOnly ? undefined : body);
}

function manifest(): string {
  return JSON.stringify({
    id: "/",
    name: "Pi Sessions",
    short_name: "Pi",
    description: "Attach to live terminal Pi sessions through a shared local hub.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#101010",
    theme_color: "#202020",
    icons: [
      { src: "/icons/pi-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icons/pi-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  });
}

function serviceWorker(): string {
  return `
const CACHE = "pi-fwd-shell-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icons/pi-192.png", "/icons/pi-512.png"];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/sessions/") || url.pathname.startsWith("/general/")) return;
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (url.pathname === "/") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/")),
    );
    return;
  }
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch {}
  const title = payload.title || "Pi finished";
  const options = {
    body: payload.body || "A session is waiting for input.",
    icon: "/icons/pi-192.png",
    badge: "/icons/pi-192.png",
    tag: payload.tag || "pi-session-finished",
    data: { url: payload.url || "/" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (client.url === target && "focus" in client) return client.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on("data", (c: Buffer) => {
      if (settled) return;
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function listPayload(): Array<Omit<SessionRow, "lastHeartbeat"> & { lastHeartbeat: number }> {
  sweep();
  return [...sessions.values()].map((row) => ({ ...row }));
}

function renderIndex(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#202020">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Pi">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/icons/pi-192.png">
<title>Pi sessions</title>
<style>
:root {
  color-scheme: dark light;
  --bg: #101010;
  --panel: #181818;
  --panel-2: #222;
  --text: #e2e2e2;
  --muted: #999;
  --border: #414141;
  --accent: #6bc49a;
  --shadow: #0007;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f2f2f2;
    --panel: #fff;
    --panel-2: #e9e9e9;
    --text: #202020;
    --muted: #686868;
    --border: #bbb;
    --accent: #247652;
    --shadow: #0002;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--text);
  background: var(--bg);
  font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
  color: var(--bg);
  background: var(--text);
  box-shadow: 0 3px 12px var(--shadow);
}
header h1 { flex: 1; margin: 0; font-size: 17px; }
button {
  min-height: 34px;
  padding: 5px 10px;
  color: inherit;
  background: transparent;
  border: 1px solid currentColor;
  border-radius: 5px;
  font: inherit;
}
main { width: min(920px, 100%); margin: 0 auto; padding: 18px 12px 60px; }
#summary { margin: 0 0 16px; color: var(--muted); }
.repo {
  margin: 0 0 18px;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 15px var(--shadow);
}
.repo-head { padding: 11px 13px; background: var(--panel-2); border-bottom: 1px solid var(--border); }
.repo-title { margin: 0; font-size: 16px; color: var(--accent); }
.repo-path, .session-path { color: var(--muted); overflow-wrap: anywhere; }
.session {
  display: block;
  padding: 12px 13px;
  color: inherit;
  text-decoration: none;
  border-bottom: 1px solid var(--border);
  touch-action: manipulation;
}
.session:last-child { border-bottom: 0; }
.session:hover, .session:focus-visible { background: color-mix(in srgb, var(--accent) 9%, transparent); }
.session-top { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
.session-id { flex: 1; min-width: 0; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
.live { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px var(--accent); }
.meta { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 8px; color: var(--muted); font-size: 12px; }
.badge { padding: 1px 5px; border: 1px solid var(--border); border-radius: 999px; }
.empty { padding: 28px 14px; text-align: center; color: var(--muted); border: 1px dashed var(--border); border-radius: 8px; }
#settings {
  position: fixed;
  z-index: 20;
  top: 58px;
  right: 8px;
  width: min(340px, calc(100vw - 16px));
  padding: 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px var(--shadow);
}
#settings[hidden] { display: none; }
#settings h2 { margin: 0 0 10px; font-size: 16px; }
#settings h3 { margin: 14px 0 4px; font-size: 14px; }
#settings p { margin: 4px 0; color: var(--muted); }
#settings button { width: 100%; margin-top: 8px; color: var(--text); border-color: var(--border); }
</style>
<header>
  <h1>Pi sessions</h1>
  <button type="button" id="settings-button" aria-label="Service settings">⚙</button>
</header>
<aside id="settings" hidden>
  <h2>Settings</h2>
  <h3>App</h3>
  <p id="app-status">Checking…</p>
  <button type="button" id="install-button" hidden>Install Pi Sessions</button>
  <h3>Notifications</h3>
  <p id="push-status">Checking…</p>
  <button type="button" id="push-button" hidden>Enable notifications</button>
</aside>
<main>
  <p id="summary">Discovering Pi instances…</p>
  <div id="repositories"></div>
</main>
<script>
const settingsButton = document.getElementById("settings-button");
const settings = document.getElementById("settings");
const summary = document.getElementById("summary");
const repositories = document.getElementById("repositories");
const appStatus = document.getElementById("app-status");
const installButton = document.getElementById("install-button");
const pushStatus = document.getElementById("push-status");
const pushButton = document.getElementById("push-button");
let installPrompt;
let workerRegistration;
settingsButton.addEventListener("click", () => { settings.hidden = !settings.hidden; });
document.addEventListener("pointerdown", (event) => {
  if (!settings.hidden && event.target !== settingsButton && !settings.contains(event.target)) {
    settings.hidden = true;
  }
});
function isStandalone() {
  return matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
}
function syncInstallStatus() {
  if (isStandalone()) {
    appStatus.textContent = "Installed";
    installButton.hidden = true;
    return;
  }
  if (installPrompt) {
    appStatus.textContent = "Ready to install";
    installButton.hidden = false;
    return;
  }
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  appStatus.textContent = ios
    ? "Share → Add to Home Screen"
    : isSecureContext
      ? "Available from the browser install menu"
      : "HTTPS required for installation";
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  syncInstallStatus();
});
window.addEventListener("appinstalled", () => {
  installPrompt = undefined;
  syncInstallStatus();
});
installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  await installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = undefined;
  syncInstallStatus();
});
function applicationServerKey(value) {
  const padding = "=".repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
async function storeSubscription(subscription) {
  const response = await fetch("/general/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      subject: location.origin,
    }),
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
}
async function syncPushStatus() {
  if (!workerRegistration || !("PushManager" in window) || !("Notification" in window)) {
    pushStatus.textContent = "Unavailable";
    pushButton.hidden = true;
    return;
  }
  const subscription = await workerRegistration.pushManager.getSubscription();
  if (subscription) {
    await storeSubscription(subscription);
    pushStatus.textContent = "Enabled";
    pushButton.textContent = "Disable notifications";
    pushButton.hidden = false;
    return;
  }
  if (Notification.permission === "denied") {
    pushStatus.textContent = "Blocked in system settings";
    pushButton.hidden = true;
    return;
  }
  pushStatus.textContent = "Off";
  pushButton.textContent = "Enable notifications";
  pushButton.hidden = false;
}
pushButton.addEventListener("click", async () => {
  pushButton.disabled = true;
  try {
    const current = await workerRegistration.pushManager.getSubscription();
    if (current) {
      await fetch("/general/push/subscriptions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: current.endpoint }),
      });
      await current.unsubscribe();
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        await syncPushStatus();
        return;
      }
      const configResponse = await fetch("/general/push/config", { cache: "no-store" });
      if (!configResponse.ok) throw new Error("HTTP " + configResponse.status);
      const config = await configResponse.json();
      const subscription = await workerRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey),
      });
      await storeSubscription(subscription);
    }
    await syncPushStatus();
  } catch (error) {
    pushStatus.textContent = "Error: " + error;
  } finally {
    pushButton.disabled = false;
  }
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js", { scope: "/" })
    .then(async (registration) => {
      workerRegistration = registration;
      syncInstallStatus();
      await syncPushStatus();
    })
    .catch(() => {
      appStatus.textContent = "Installation unavailable";
      pushStatus.textContent = "Unavailable";
    });
} else {
  appStatus.textContent = "Installation unsupported";
  pushStatus.textContent = "Unavailable";
}
syncInstallStatus();
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function relativePath(root, cwd) {
  if (cwd === root) return ".";
  return cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : cwd;
}
function render(rows) {
  repositories.replaceChildren();
  const groups = new Map();
  for (const row of rows) {
    const key = row.repoRoot || row.cwd;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const ordered = [...groups.entries()].sort((a, b) =>
    String(a[1][0].repoName).localeCompare(String(b[1][0].repoName)));
  summary.textContent = rows.length
    ? rows.length + " live session" + (rows.length === 1 ? "" : "s") +
      " across " + groups.size + " repositor" + (groups.size === 1 ? "y" : "ies")
    : "No live Pi sessions.";
  if (!rows.length) {
    repositories.append(node("div", "empty", "Start Pi with the forwarding plugin loaded."));
    return;
  }
  for (const [root, sessions] of ordered) {
    sessions.sort((a, b) => String(a.cwd).localeCompare(String(b.cwd)));
    const section = node("section", "repo");
    const head = node("div", "repo-head");
    head.append(node("h2", "repo-title", sessions[0].repoName || root));
    head.append(node("div", "repo-path", root));
    section.append(head);
    for (const session of sessions) {
      const entry = session.uiEntry && session.uiEntry.startsWith("/") ? session.uiEntry : "/";
      const link = node("a", "session");
      link.href = "/sessions/" + encodeURIComponent(session.id) + entry;
      const top = node("div", "session-top");
      top.append(node("span", "live"));
      top.append(node("span", "session-id", session.sessionTitle || relativePath(root, session.cwd)));
      link.append(top);
      link.append(node("div", "session-path", relativePath(root, session.cwd) + " · " + session.cwd));
      const meta = node("div", "meta");
      meta.append(node("span", "badge", "protocol " + (session.protocolVersion || "?")));
      meta.append(node("span", "badge", "plugin " + (session.pluginRevision || "unknown")));
      meta.append(node("span", "", "pid " + session.pid));
      meta.append(node("span", "", "port " + session.port));
      meta.append(node("span", "", "seen " + Math.max(0, Math.round((Date.now() - session.lastHeartbeat) / 1000)) + "s ago"));
      link.append(meta);
      section.append(link);
    }
    repositories.append(section);
  }
}
async function refresh() {
  try {
    const response = await fetch("/general/sessions", { cache: "no-store" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    render(await response.json());
  } catch (error) {
    summary.textContent = "Session discovery unavailable: " + error;
  }
}
refresh();
setInterval(refresh, 3000);
</script>
`;
}

function sessionProxy(pathname: string): { id: string; rest: string | undefined } | null {
  const sess = /^\/sessions\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!sess) return null;
  try {
    return { id: decodeURIComponent(sess[1]), rest: sess[2] };
  } catch {
    return null;
  }
}

function proxyPath(restPath: string, search: string): string {
  const path = restPath.startsWith("/") ? restPath : `/${restPath}`;
  return `${path}${search}`;
}

function proxy(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  row: SessionRow,
  restPath: string,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = proxyPath(restPath, url.search);
  const headers = { ...req.headers, host: `127.0.0.1:${row.port}` };
  delete headers.connection;
  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: row.port,
      path,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on("error", () => {
    if (!res.headersSent) json(res, 502, { error: "proxy failed" });
    else res.destroy();
  });
  proxyReq.setTimeout(PROXY_CONNECT_TIMEOUT_MS, () => {
    proxyReq.destroy(new Error("proxy timeout"));
  });
  req.pipe(proxyReq);
}

function writeSocketHead(
  socket: { write: (chunk: string | Buffer) => boolean },
  status: number,
  reason: string,
  headers: http.IncomingHttpHeaders | Record<string, string | string[] | undefined>,
): void {
  let out = `HTTP/1.1 ${status} ${reason}\r\n`;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) out += `${key}: ${item}\r\n`;
    } else {
      out += `${key}: ${value}\r\n`;
    }
  }
  out += "\r\n";
  socket.write(out);
}

function proxyUpgrade(
  req: http.IncomingMessage,
  socket: import("node:stream").Duplex,
  head: Buffer,
  row: SessionRow,
  restPath: string,
): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = proxyPath(restPath, url.search);
  const headers = { ...req.headers, host: `127.0.0.1:${row.port}` };
  const proxyReq = http.request({
    hostname: "127.0.0.1",
    port: row.port,
    path,
    method: req.method ?? "GET",
    headers,
  });
  const connectTimer = setTimeout(() => {
    proxyReq.destroy(new Error("proxy connect timeout"));
  }, PROXY_CONNECT_TIMEOUT_MS);
  connectTimer.unref();
  proxyReq.on("error", () => {
    clearTimeout(connectTimer);
    socket.destroy();
  });
  proxyReq.on("response", (proxyRes) => {
    clearTimeout(connectTimer);
    writeSocketHead(socket, proxyRes.statusCode ?? 502, proxyRes.statusMessage ?? "Error", proxyRes.headers);
    proxyRes.pipe(socket);
  });
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    clearTimeout(connectTimer);
    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
    writeSocketHead(socket, 101, "Switching Protocols", proxyRes.headers);
    if (proxyHead.length) socket.write(proxyHead);
    if (head.length) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });
  proxyReq.end();
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", HUB_ORIGIN);
  const method = req.method ?? "GET";
  const pathname = url.pathname;
  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    json(res, 413, { error: "request body too large" });
    return;
  }

  if ((method === "GET" || method === "HEAD") && pathname === "/manifest.webmanifest") {
    staticBody(res, "application/manifest+json; charset=utf-8", manifest(), {
      "cache-control": "no-cache",
    }, method === "HEAD");
    return;
  }
  if ((method === "GET" || method === "HEAD") && pathname === "/sw.js") {
    staticBody(res, "text/javascript; charset=utf-8", serviceWorker(), {
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    }, method === "HEAD");
    return;
  }
  if ((method === "GET" || method === "HEAD") && pathname === "/icons/pi-192.png") {
    staticBody(res, "image/png", ICON_192, { "cache-control": "public, max-age=31536000, immutable" }, method === "HEAD");
    return;
  }
  if ((method === "GET" || method === "HEAD") && pathname === "/icons/pi-512.png") {
    staticBody(res, "image/png", ICON_512, { "cache-control": "public, max-age=31536000, immutable" }, method === "HEAD");
    return;
  }
  if (method === "GET" && pathname === "/") {
    html(res, 200, renderIndex());
    return;
  }
  if (method === "GET" && pathname === "/general/push/config") {
    json(res, 200, {
      publicKey: pushState.vapid.publicKey,
      subscriptions: pushState.subscriptions.length,
    });
    return;
  }
  if (method === "POST" && pathname === "/general/push/subscriptions") {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "null");
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const bodyRecord = body && typeof body === "object"
      ? body as Record<string, unknown>
      : {};
    const subscription = bodyRecord.subscription ?? body;
    if (!validPushSubscription(subscription)) {
      json(res, 400, { error: "invalid push subscription" });
      return;
    }
    const requestSubject = httpsOrigin(req.headers.origin);
    const bodySubject = httpsOrigin(bodyRecord.subject);
    const vapidSubject = requestSubject ?? bodySubject ?? subscription.vapidSubject;
    const storedSubscription: PushSubscription = {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime,
      keys: subscription.keys,
      ...(vapidSubject ? { vapidSubject } : {}),
    };
    pushState = {
      ...pushState,
      subscriptions: [
        ...pushState.subscriptions.filter((item) => item.endpoint !== storedSubscription.endpoint),
        storedSubscription,
      ],
    };
    savePushState();
    json(res, 200, { ok: true });
    return;
  }
  if (method === "DELETE" && pathname === "/general/push/subscriptions") {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "null");
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint !== "string") {
      json(res, 400, { error: "need endpoint" });
      return;
    }
    pushState = {
      ...pushState,
      subscriptions: pushState.subscriptions.filter((item) => item.endpoint !== endpoint),
    };
    savePushState();
    json(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && pathname === "/general/push/notify") {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "null");
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const notice = body as { sessionId?: unknown; firstLine?: unknown } | null;
    const sessionId = notice?.sessionId;
    if (typeof sessionId !== "string") {
      json(res, 400, { error: "need sessionId" });
      return;
    }
    const session = sessions.get(sessionId);
    if (!session) {
      json(res, 404, { error: "unknown session" });
      return;
    }
    const entry = session.uiEntry.startsWith("/") ? session.uiEntry : "/";
    const cwdName = basename(session.cwd) || session.repoName;
    const firstLine = typeof notice?.firstLine === "string"
      ? notice.firstLine.replace(/\s+/g, " ").trim().slice(0, 240)
      : "";
    void sendPush({
      title: session.sessionTitle || "Pi session",
      body: `${cwdName} · ${session.id}${firstLine ? `\n${firstLine}` : ""}`,
      tag: `pi-session-${session.id}`,
      url: `/sessions/${encodeURIComponent(session.id)}${entry}`,
    });
    json(res, 202, { ok: true });
    return;
  }
  if (method === "GET" && pathname === "/general/sessions") {
    json(res, 200, listPayload());
    return;
  }
  if (method === "POST" && pathname === "/general/sessions") {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "null");
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const rec = body as Record<string, unknown>;
    const id = typeof rec.id === "string" && rec.id ? rec.id : null;
    const pid = typeof rec.pid === "number" ? rec.pid : Number(rec.pid);
    const port = typeof rec.port === "number" ? rec.port : Number(rec.port);
    const cwd = typeof rec.cwd === "string" ? rec.cwd : null;
    const sessionTitle = typeof rec.sessionTitle === "string" && rec.sessionTitle.trim()
      ? rec.sessionTitle.replace(/\s+/g, " ").trim().slice(0, 200)
      : "New session";
    const repoRoot = typeof rec.repoRoot === "string" && rec.repoRoot ? rec.repoRoot : cwd;
    const repoName = typeof rec.repoName === "string" && rec.repoName
      ? rec.repoName.slice(0, 200)
      : repoRoot
        ? basename(repoRoot)
        : null;
    const protocolCandidate = Number(rec.protocolVersion);
    const protocolVersion = Number.isInteger(protocolCandidate)
      ? protocolCandidate
      : 0;
    const pluginRevision = typeof rec.pluginRevision === "string" && rec.pluginRevision
      ? rec.pluginRevision.slice(0, 100)
      : "unknown";
    const requestedUiEntry = typeof rec.uiEntry === "string" ? rec.uiEntry : "/";
    const uiEntry = requestedUiEntry.startsWith("/") && !requestedUiEntry.includes("..")
      ? requestedUiEntry
      : "/";
    if (
      !id ||
      id.length > 200 ||
      id.includes("/") ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      !cwd ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      !Number.isInteger(port) ||
      port <= 0 ||
      port > 65535
    ) {
      json(res, 400, { error: "need id, pid, port, cwd" });
      return;
    }
    const previous = sessions.get(id);
    const row = {
      id,
      pid,
      port,
      cwd,
      sessionTitle,
      repoRoot: repoRoot!,
      repoName: repoName || repoRoot!,
      protocolVersion,
      pluginRevision,
      uiEntry,
      lastHeartbeat: Date.now(),
    };
    sessions.set(id, row);
    if (
      !previous ||
      previous.port !== port ||
      previous.pluginRevision !== pluginRevision ||
      previous.cwd !== cwd
    ) {
      log(`register id=${id} pid=${pid} port=${port} cwd=${cwd}`);
    }
    json(res, 200, { ok: true, id });
    return;
  }

  const hb = /^\/general\/sessions\/([^/]+)\/heartbeat$/.exec(pathname);
  if (method === "POST" && hb) {
    const id = decodeURIComponent(hb[1]);
    const row = sessions.get(id);
    if (!row) {
      json(res, 404, { error: "unknown session" });
      return;
    }
    row.lastHeartbeat = Date.now();
    json(res, 200, { ok: true });
    return;
  }

  const del = /^\/general\/sessions\/([^/]+)$/.exec(pathname);
  if (method === "DELETE" && del) {
    const id = decodeURIComponent(del[1]);
    sessions.delete(id);
    log(`delete ${id}`);
    json(res, 200, { ok: true });
    return;
  }

  const sess = sessionProxy(pathname);
  if (sess) {
    sweep();
    const row = sessions.get(sess.id);
    if (!row) {
      json(res, 404, { error: "unknown session" });
      return;
    }
    if (sess.rest === undefined) {
      res.writeHead(302, { location: `/sessions/${encodeURIComponent(sess.id)}/` });
      res.end();
      return;
    }
    proxy(req, res, row, sess.rest);
    return;
  }

  json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    if (!res.headersSent) json(res, 500, { error: String(err) });
    else res.destroy();
  });
});
server.maxConnections = 128;
server.headersTimeout = 10_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", HUB_ORIGIN);
  const sess = sessionProxy(url.pathname);
  if (!sess) {
    writeSocketHead(socket, 404, "Not Found", { connection: "close" });
    socket.destroy();
    return;
  }
  sweep();
  const row = sessions.get(sess.id);
  if (!row) {
    writeSocketHead(socket, 404, "Not Found", { connection: "close" });
    socket.destroy();
    return;
  }
  proxyUpgrade(req, socket, head, row, sess.rest ?? "/");
});

server.listen(PORT, HOST, () => {
  log(`listening on ${HUB_ORIGIN}/`);
});

server.on("error", (err) => {
  process.stderr.write(`pi-fwd: ${err}\n`);
  process.exit(1);
});

setInterval(sweep, SWEEP_MS).unref();

function shutdown(): void {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
