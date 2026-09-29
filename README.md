# pi-fwd

`pi-fwd` attaches browsers to real interactive Pi terminal processes. It does
not create another agent runtime or a virtual session: each running Pi TUI
continues to own its model session, editor, tools, and session file.

## Features

- A shared hub discovers live Pi processes through registration and heartbeat.
- The picker groups sessions from multiple repositories.
- Each Pi process serves its own session UI revision behind the shared hub.
- Browser input travels through Pi's real terminal editor and focused TUI
  component, including slash commands, selectors, paste, and multiline input.
- Assistant Markdown and aggregated thinking stream into separate stable
  transcript cards.
- Built-in and custom tools render through Pi's `ToolExecutionComponent`.
- Read, Write, Edit, and Apply Patch cards use semantic headers with file,
  range, line, replacement, and patch-size summaries. Read starts collapsed.
- Specialized Pi tool variants keep Pi's terminal renderer when a semantic
  renderer does not own their presentation. Unrecognized transcript
  components also fail open to bounded terminal rendering.
- Tool output cards start collapsed on mobile and retain independent
  disclosure state for each attached browser.
- Tool calls without a terminal result after an interrupted run are marked
  **Interrupted** in the card header instead of retaining a running spinner.
- The `@mjakl/pi-subagent` tool receives a structured browser renderer when
  that independent extension is installed.
- Pi session names are editable inline. Unnamed sessions use the first line of
  their initial prompt.
- Session settings expose the current composed system prompt as a sanitized
  Markdown preview in a new tab.
- The responsive UI supports desktop and mobile layouts, iOS keyboard
  positioning, light/dark themes, completion sounds, and PWA installation.
- Web Push subscriptions and VAPID keys persist locally. Completion
  notifications link to the associated live session.

## Architecture

Two cooperating servers make up the forwarder:

1. `hub/hub.ts` is the shared directory and reverse proxy.
2. `extensions/pi-fwd.ts` runs inside each TUI Pi process and owns that
   process's session page and WebSocket.

The extension registers its process ID, selected port, repository metadata,
protocol/plugin revision, cwd, and display title with the hub. The hub proxies
`/sessions/:id/*` to that registered server. Browser WebSocket input returns
to the same Pi process and enters its terminal-input path.

The hub owns only shared resources:

- `/`
- `/general/*`
- `/manifest.webmanifest`
- `/sw.js`
- `/icons/*`

The selected Pi extension owns everything below `/sessions/:id/*`.

## Requirements

- Pi `0.87.1` or newer.
- Node.js `22` or newer.
- npm for installing runtime dependencies. No npm registry publication is
  required; npm can install this package directly from a Git commit.

## Install from a checkout

```sh
npm ci
pi install "$(pwd)"
```

The included convenience script performs both steps:

```sh
./install
```

Start the hub:

```sh
./bin/pi-fwd
```

Then start or reload Pi and open:

```text
http://127.0.0.1:30142/
```

The package exposes `pi-fwd` as an npm binary, so a Git dependency installed
under another package can run it through that package's `node_modules/.bin`.

## Install from GitHub

After the repository is published, npm can pin it to an exact commit without
publishing it to the npm registry:

```json
{
  "dependencies": {
    "pi-fwd": "github:OWNER/pi-fwd#COMMIT_SHA"
  }
}
```

Run `npm install`, install `node_modules/pi-fwd` as a Pi package, and launch
`node_modules/.bin/pi-fwd`.

Pi can also install the extension directly from Git:

```sh
pi install git:github.com/OWNER/pi-fwd@COMMIT_SHA
```

Using a small host package is preferable when a stable filesystem path is
needed for the separately launched hub service.

## Configuration

### `PI_FWD_HUB_ADDR`

Address on which the hub listens and the default address extensions use to
reach it:

```sh
PI_FWD_HUB_ADDR=127.0.0.1:30142 ./bin/pi-fwd
PI_FWD_HUB_ADDR=0.0.0.0:30142 ./bin/pi-fwd
```

The default is `127.0.0.1:30142`. HTTP URL syntax is also accepted. When the
bind host is `0.0.0.0` or `::`, a colocated extension connects through the
corresponding loopback address.

### `PI_FWD_AGENT_SERIES_START`

By default, each Pi extension asks the kernel for an ephemeral port. Set this
variable to choose the lowest unoccupied port at or above a known starting
point:

```sh
PI_FWD_AGENT_SERIES_START=31000 pi
```

The first process uses `31000`, the next uses `31001` when `31000` is occupied,
and so on. Series mode binds agent listeners to `0.0.0.0` inside their
environment so container port publishing can reach them; default ephemeral
mode remains loopback-only. Publish the same numbered range onto the hub
host's loopback interface.

### Other variables

- `PI_FWD_PUSH_STATE`: VAPID/subscription state file. Defaults to
  `$XDG_STATE_HOME/pi-fwd/push-state.json` or
  `~/.local/state/pi-fwd/push-state.json`.
- `PI_FWD_VAPID_SUBJECT`: fallback VAPID contact URI.
- `PI_FWD_LOG`: optional extension diagnostic log path.

## Trust boundary

`pi-fwd` intentionally has no login or application-level access-control
system. It is a localhost or localhost-adjacent operator tool. Access to the
hub is equivalent to access to the attached Pi terminals.

Use loopback, container port publishing, Tailscale ACLs, or an equivalent
network boundary. Do not expose it to an untrusted network.

Basic resource limits are enforced: bounded request bodies and WebSocket
frames, connection caps, and HTTP/proxy timeouts.

## PWA and notifications

The service worker caches only the shared picker shell and bypasses live
session/plugin routes. Web Push requires a secure browser context. For iOS,
install the site to the Home Screen and access it over HTTPS, such as through
Tailscale Serve.

Push notifications are sent after `agent_settled` only when no attached
session tab reports itself visible.

## Test

The test suite includes focused presentation-state checks and a minimal hub
smoke test:

```sh
npm test
```

It checks thinking aggregation, tool card defaults, address parsing,
deterministic agent-port selection, hub startup, request-size enforcement,
registration, listing, HTTP proxying, and deletion. It is not a security,
browser, mobile, push-delivery, or compatibility qualification suite.

Run syntax checks separately:

```sh
npm run check
```

`npm run build` produces the plain-JavaScript hub at `dist/hub.js`. The
package's `prepare` lifecycle runs this automatically for Git installs; the
generated hub is also checked into release commits so production installs do
not need to execute TypeScript from `node_modules`.
