# Always-on Chrome harness

The harness supervises one Chrome per named profile, using a persistent data
directory and a fixed **loopback-only** CDP port. Chrome stays running when
agents disconnect. The supervisor restarts an exited browser and checks CDP
health every five seconds; three consecutive failures trigger a restart.
Optional systemd user services restart the supervisor too, survive logout,
and start at boot when linger is enabled.

Each agent starts its **own stdio MCP server** attached to the shared Chrome:

```text
agent A → public-browser --attach ─┐
                                 ├→ Chrome :9222 → persistent default profile
agent B → public-browser --attach ─┘       ↑
                                     supervisor
```

The MCP server processes keep separate active tabs, refs, and caches. Sharing
one MCP process between agents would share that state and cause tab fights.

## Direct CLI (no npm required)

Install from this checkout:

```bash
sh harness/install-cli.sh
pb-harness status
pb-harness doctor
pb-harness start
pb-harness stop
pb-harness restart
pb-harness logs -f
pb-harness profiles
pb-harness path
pb-harness enable
```

Both `pb-harness` and `public-browser-harness` are installed in
`~/.local/bin` (or a directory passed to the installer). Keep the checkout
at its installed path. `enable` installs the user service and enables linger
for boot/logout persistence. No npm process is needed at runtime.

### Pinning an existing profile safely

Machine-specific settings belong in git-ignored `harness/profiles.local.json`:

```json
{
  "ownerUid": 1000,
  "stateDir": "/home/drew/.public-browser/harness",
  "profiles": {
    "default": {
      "userDataDir": "/home/drew/.public-browser/harness/default/chrome-profile",
      "profileDirectory": "Profile 1",
      "expectedProfileName": "Agent"
    }
  }
}
```

Use your own UID and absolute paths. With `ownerUid`, commands reject other
users (including sudo/root), and generated units have a `ConditionUser` guard.
With `expectedProfileName`, startup and every browser relaunch verify the
selected directory's name in Chrome's `Local State`; missing or mismatched
profiles cause an error instead of silently creating a fresh profile.
If intentionally renaming the profile in Chrome, update this pin too.
`doctor` checks the pin, and `status --json` reports it.

Browser preferences, extensions and cookies remain in the persistent Chrome
directory. The JSON files retain harness options across restart; restarting
does not reset either. Chrome display availability is still required for a
headed browser at boot.

## Quick start

From this checkout (Node 20+ and Chrome/Chromium required):

```bash
npm ci
npm run build
node harness/harness.mjs doctor
node harness/harness.mjs up
node harness/harness.mjs status
node harness/harness.mjs mcp default --client cursor
```

`up` starts a detached supervisor, or starts the installed systemd unit, and
waits for `http://127.0.0.1:9222/json/version`. `--no-wait` skips that wait.
An unrelated Chrome already on the port is not silently adopted: stop it or
choose another port so that agents don't unknowingly use the wrong profile.

## Connect any MCP client

Print configuration with absolute paths for **this installed build**:

```bash
node harness/harness.mjs mcp default --client claude
node harness/harness.mjs mcp default --client cursor
node harness/harness.mjs mcp default --client cline
node harness/harness.mjs mcp default --client opencode
node harness/harness.mjs mcp default --client json
```

The generated configuration runs the local `build/index.js`, not an unpatched
`npx public-browser@latest`. Keep this installation at the configured path and
rebuild after source changes. For a generic stdio client the command is:

```text
command: /absolute/path/to/node
args:    /absolute/path/to/public-browser/build/index.js --attach --host 127.0.0.1 --port 9222
```

Example Cursor/Cline configuration (prefer the generated JSON):

```json
{
  "mcpServers": {
    "public-browser": {
      "command": "/usr/bin/node",
      "args": ["/root/Tools/public-browser/build/index.js", "--attach", "--host", "127.0.0.1", "--port", "9222"],
      "env": {
        "PUBLIC_BROWSER_DOWNLOAD_DIR": "/root/.public-browser/harness/default/downloads",
        "PUBLIC_BROWSER_PROFILE": "",
        "SILBERCUE_CHROME_PROFILE": ""
      }
    }
  }
}
```

Separate agent processes may use the same server name and config. Only two
entries within the *same* client configuration need distinct names. After
adding an MCP server, restart your client if it caches server definitions.
Call `virtual_desk` before `navigate` to review the agent's tabs.

## Persistent profiles

Configure profiles in `harness/profiles.json`, or create a git-ignored
`harness/profiles.local.json` with overrides. Profiles are merged by name.
Each profile needs its own port and its own data directory:

```json
{
  "defaultProfile": "default",
  "stateDir": "~/.public-browser/harness",
  "profiles": {
    "default": { "port": 9222 },
    "work": { "port": 9333 },
    "research": { "port": 9334, "headless": true }
  }
}
```

```bash
node harness/harness.mjs up --all
node harness/harness.mjs mcp work --client cursor
node harness/harness.mjs path work
```

By default, state is stored outside the repository:

```text
~/.public-browser/harness/<profile>/
  chrome-profile/   # Chrome user data: cookies, logins, history, extensions
  downloads/
  harness.log       # supervisor and Chrome output; rotated between launches
  harness.pid
  chrome.pid
  harness.lock
```

Log in once in the harness's visible Chrome. Profile data remains across
normal restarts; sites can still expire or revoke sessions, and a hard crash
can lose recent unflushed writes. A dedicated profile starts empty — existing
browser accounts are **not automatically imported**. To migrate an existing
Chrome user-data directory, stop its Chrome and the harness, copy the entire
directory (including `Local State`) to a dedicated location, and set
`userDataDir` and optionally `profileDirectory` (default `Default`). Back up
before migrating; encrypted credentials may depend on the original OS keyring.
Do not use Chrome's default data directory: modern Chrome refuses remote
debugging there. Profiles are selected by harness port, not by the MCP
`configure_session(profile: ...)` option.

Other profile options include `chromePath`, `headless`, `stealth`,
`restoreLastSession`, `windowSize`, `startupUrl`, `env`, `extraArgs`,
`startupTimeoutMs`, `healthTimeoutMs`, `restartDelayMs`, and
`maxRestartDelayMs`. `extraArgs` cannot override the CDP/profile ownership
flags. `CHROME_PATH` also selects a binary. See `profiles.example.json`.

Use an alternate config with:

```bash
node harness/harness.mjs --config /etc/public-browser/harness.json up
# Or set PUBLIC_BROWSER_HARNESS_CONFIG to that path.
```

## Concurrency and recovery

For a stable agent identity, generate config with:

```bash
node harness/harness.mjs mcp default --client cursor --agent-id cursor-main
node harness/harness.mjs mcp default --client json --agent-id pi-main
```

The MCP entry point accepts `--attach --agent-id pi-main` (or
`PUBLIC_BROWSER_AGENT_ID=pi-main`). Reuse that ID only for the same logical
agent, not every client on the machine. Keep the MCP connection alive during a
task. A named agent preserves its owned target IDs and active tab on disconnect,
and reattaches to those exact surviving targets after a process restart. It
never adopts the user's foreground tab. Closed targets are discarded; after a
Chrome restart a new owned page is created. This does not preserve element refs:
call `view_page` after reconnecting.

Each attached agent's first page, and each explicitly opened isolated page,
uses a separate Chrome window in headed mode, so Chrome cannot insert it into
another agent's or a human's foreground window. This intentionally favors
isolation over grouping all pages into one window. Cookies remain shared.

Named identities are exclusively leased. A concurrent MCP process with the
same ID fails rather than fighting over tabs. Lease/state files are private to
the OS user under `~/.public-browser/agent-tabs/`. On graceful disconnect the
lease is released. After a hard crash, the error names the lock directory;
check its `owner.json` PID and confirm no owner is running before removing that
specific `.lock` directory. Locks are deliberately not auto-stolen. Do not
share a named identity across hosts accessing the same remote CDP endpoint.

- Every agent starts with its own tab, but `virtual_desk` shows **all** browser
  tabs with `owned` / `shared; not owned` labels. Use `scope: "owned"` for a
  private-only view. Tab numbers refer to the global list and can change;
  prefer exact target IDs.
- `switch_tab(tab: "<shared target ID>", allow_shared: true)` explicitly accesses
  any shared page without claiming it. An agent's active CDP target remains
  local to that agent; switching does not change another agent's active target.
  In isolated sessions this is background-only unless `focus: true` is passed.
  All normal tools then operate on the selected page, so shared edits can
  conflict if two agents deliberately use the same page. Shared browsing is
  cooperative access, not a per-page writer lock or security boundary.
- Shared pages cannot be closed through `switch_tab`, are never included in
  shutdown cleanup, and are not restored as owned targets on reconnect.
- Tabs opened with `switch_tab(action: "open")` are owned by that agent.
  A click-created popup is claimed only when Chrome reports that the active
  tab is its opener. Unattributable popups are deliberately not claimed, to
  avoid stealing another agent's tabs. Prefer `switch_tab` for explicit URLs.
- Graceful anonymous MCP shutdown closes **all** of that agent's owned tabs. Named (`--agent-id`) sessions retain theirs. It does not
  close Chrome or other agents' tabs. Abruptly killing the MCP process may
  leave tabs behind; ownership filtering is not a security boundary against
  another process with direct CDP access.
- Transport reconnection reuses surviving owned tabs. After a Chrome restart,
  the same MCP process can reconnect on a later call, but it may get a new
  blank tab and must navigate again. In-flight calls can fail during recovery.
  A fixed endpoint is not a literally unbreakable WebSocket connection.
- Cookies, local storage, downloads, browser-wide settings, and account-side
  effects remain shared. One agent logging out affects the others. Use
  separate profiles for separate accounts or stronger workflow isolation.
- Use the generated download directory for all agents on the same profile;
  Chrome's download behavior is browser-wide, and the last configuration wins.

## Always on with systemd

The npm package bundles the supervisor, profile configs and systemd unit template.
It exposes `public-browser-harness` alongside the MCP executable `public-browser`.
Chrome itself is an external prerequisite, not included in the package.

After installing the package in a stable location (for example with
`npm install -g /path/to/public-browser-3.0.0.tgz`):

```bash
public-browser-harness doctor
public-browser-harness install-service default
public-browser-harness status --json
```

From a source checkout, the equivalent npm commands are:

```bash
npm run harness:install-service -- default
npm run harness:status -- --json
npm run harness:logs -- default -f
# npm run harness:restart -- default  # disconnects attached agents briefly
# npm run harness:uninstall-service -- --all
npm run harness:test
```

Installation is explicit: installing the npm package does not start Chrome or
change services automatically. The generated service uses absolute Node,
supervisor and config paths. Keep the package at that location, and rerun
`install-service` if it moves. Config overrides and live browser state are
excluded from the package. Existing active service instances are not restarted
by `install-service`; use `restart` only when you intend to interrupt Chrome.

For OpenCode v2 (which nests entries under `mcp.servers`), register the built MCP
server with its native command:

```bash
opencode mcp add --global public-browser -- /absolute/path/to/node /absolute/path/to/public-browser/build/index.js --attach --agent-id auto --host 127.0.0.1 --port 9222
opencode reload
opencode mcp list
```

`--agent-id auto` gives each MCP process its own identity, avoiding collisions
between agents. Do not run the stdio MCP server itself as one shared systemd
service: the service owns Chrome; each agent owns its MCP connection.

The direct installer also remains available:

```bash
node harness/harness.mjs install-service default
# Or: node harness/harness.mjs install-service --all
```

This installs `~/.config/systemd/user/public-browser-harness@.service`, enables
the selected instances, and tries `loginctl enable-linger`. If needed, run:

```bash
loginctl enable-linger "$USER"
```

A working systemd user manager is required. Minimal root/server sessions may
need `systemctl start user@$(id -u).service` first. The CLI locates the user
manager bus under `/run/user/<uid>` when a desktop exports a private bus.

For visible Chrome, the service captures `DISPLAY` and `XAUTHORITY` from the
installing session. The desktop/X server must also start at boot. Set
`headless: true` on servers without a display. Services use `KillMode=mixed`
so the supervisor can stop Chrome gracefully and flush profile databases
before systemd resorts to killing remaining processes.

```bash
node harness/harness.mjs status --json
node harness/harness.mjs logs default -f
node harness/harness.mjs restart default
node harness/harness.mjs down default
systemctl --user status public-browser-harness@default.service
journalctl --user -u public-browser-harness@default.service -f
node harness/harness.mjs uninstall-service --all
```

`running` means CDP is healthy and the supervisor PID is alive; `starting`
means the supervisor is alive but CDP is unavailable. `unmanaged` means CDP
answers without a live supervisor. `port-conflict` means the port is not a
valid CDP endpoint. `stopped` means neither is running.

## Security

CDP is unauthenticated and intentionally bound only to `127.0.0.1`. Local
processes with access to it can control authenticated browser sessions. Do not
expose it to a network. For remote agents, use an authenticated SSH tunnel:

```bash
ssh -L 9222:127.0.0.1:9222 user@browser-host
```

Running as root requires Chrome's `--no-sandbox` in this environment; the
harness adds it automatically unless `noSandbox: false` is configured.
Prefer an unprivileged account with a working sandbox for untrusted browsing.
On Linux the default `passwordStore: "basic"` avoids keyring prompts but does
not provide normal OS-keyring protection; choose a keyring-backed store when
available. Never commit profile data, cookies, or downloaded private files.
