import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  listenOnAgentPort,
  parseAgentSeriesStart,
  parseHubAddress,
} from "../hub/net.ts";

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function freePort() {
  const server = http.createServer();
  const port = await listenOnAgentPort(server, "127.0.0.1");
  await close(server);
  return port;
}

test("address parsing and agent series select the first free port", async () => {
  assert.deepEqual(parseHubAddress("0.0.0.0:32000"), {
    host: "0.0.0.0",
    port: 32000,
  });
  assert.equal(parseAgentSeriesStart("32001"), 32001);

  const occupied = http.createServer();
  const start = await listenOnAgentPort(occupied, "127.0.0.1");
  const selected = http.createServer();
  try {
    assert.equal(
      await listenOnAgentPort(selected, "127.0.0.1", start),
      start + 1,
    );
  } finally {
    await close(selected);
    await close(occupied);
  }
});

test("hub can register, list, proxy, and delete one live session", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.end(`upstream ${req.url}`);
  });
  const upstreamPort = await listenOnAgentPort(upstream, "127.0.0.1");
  t.after(() => close(upstream));

  const hubPort = await freePort();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-fwd-smoke-"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const hub = spawn(
    process.execPath,
    ["--experimental-strip-types", new URL("../hub/hub.ts", import.meta.url).pathname],
    {
      env: {
        ...process.env,
        PI_FWD_HUB_ADDR: `127.0.0.1:${hubPort}`,
        PI_FWD_PUSH_STATE: join(stateDir, "push-state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  t.after(() => {
    hub.kill("SIGTERM");
  });

  const base = `http://127.0.0.1:${hubPort}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(`${base}/general/sessions`)).ok) {
        ready = true;
        break;
      }
    } catch {
      // Startup race.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!ready) {
    const stderr = await new Promise((resolve) => {
      let text = "";
      hub.stderr.on("data", (chunk) => {
        text += chunk;
      });
      setTimeout(() => resolve(text), 100);
    });
    assert.fail(`hub did not start: ${stderr}`);
  }

  const oversized = await fetch(`${base}/general/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "x".repeat(256 * 1024 + 1),
  });
  assert.equal(oversized.status, 413);

  const registration = {
    id: "smoke",
    pid: process.pid,
    port: upstreamPort,
    cwd: process.cwd(),
    sessionTitle: "Smoke session",
    repoRoot: process.cwd(),
    repoName: "smoke",
    protocolVersion: 1,
    pluginRevision: "test",
    uiEntry: "/",
  };
  const registered = await fetch(`${base}/general/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(registration),
  });
  assert.equal(registered.status, 200);

  const rows = await fetch(`${base}/general/sessions`).then((response) => response.json());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionTitle, "Smoke session");

  const proxied = await fetch(`${base}/sessions/smoke/hello?value=1`);
  assert.equal(proxied.status, 200);
  assert.equal(await proxied.text(), "upstream /hello?value=1");

  const removed = await fetch(`${base}/general/sessions/smoke`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    await fetch(`${base}/general/sessions`).then((response) => response.json()),
    [],
  );
});
