# Vision devcontainer

Hardened dev environment for working on Vision with the Claude CLI in
`--dangerously-skip-permissions` mode. The entire dev stack — Postgres,
backend, frontend — runs natively inside this container, so there is no
Docker-in-Docker.

## What's inside

| Component | Where it runs | Port |
| --- | --- | --- |
| PostgreSQL 18 | Native (apt) | `5432` (in-container only) |
| Backend (bun + Express) | `bun run dev` | `3002` published to `127.0.0.1` |
| Frontend (Vite) | `bun run dev` | `8080` published to `127.0.0.1` |
| Alembic migrations | Python venv at `./venv` | — |
| GitHub CLI (`gh`) | apt | — |
| Claude Code | Installed via the official `claude-code` devcontainer feature | — |

The base image is plain `debian:bookworm-slim`. The container user is
`dev` (UID 1000).

## How to use — CLI only

This sandbox runs on **apple/container** (no devcontainer CLI, no Docker).
Prerequisite: [apple/container](https://github.com/apple/container) installed and
the system VM started (`container system start`).

A host launcher at `.devcontainer/bin/claude` forwards every invocation into the
container: it stages a sanitized `~/.claude`, runs an idempotent
`container build` + `container run` (reuses an existing container if already
running), replays the post-create (once) / post-start (every start)
lifecycle as `dev`, forwards the Claude token from the Keychain, and auto-syncs
`~/.claude` back to the host on session exit.

The fish function `vision-claude` (in `~/.config/fish/functions/`) walks up from
`$PWD` to the repo (matching `.devcontainer/Dockerfile`), falls back to
`$VISION_HOME`, then runs that launcher. Use it anywhere:

```sh
vision-claude --dangerously-skip-permissions
```

To drop into a shell instead of Claude:
```sh
container exec -it --user dev vision-dev bash
```

To force a full rebuild (e.g. after changing the Dockerfile or allowlist):
```sh
VISION_REBUILD=1 vision-claude --dangerously-skip-permissions
```

## Browser access from the host

The container publishes `127.0.0.1:8080:8080` and
`127.0.0.1:3002:3002`. Once Claude (or you) runs `bun run dev`
inside the container, the host can reach:

- `http://localhost:8080` — frontend (Vite)
- `http://localhost:3002/health` — backend (Express)

Bound to `127.0.0.1` only; other devices on your LAN can't see them.

## Network policy

Egress is enforced in two layers by the root entrypoint on every start:

1. **In-container SNI proxy** (`squid`, peek+splice). All outbound
   HTTP(S) must traverse `squid` on `127.0.0.1:3128`. squid peeks the TLS
   SNI and *splices* allowed hostnames (tunnels without decrypting —
   end-to-end TLS preserved, no MITM) and terminates the rest. Hostname
   enforcement can't be bypassed by an exfil endpoint sharing an allowed
   CDN IP, and it defeats `CONNECT`-host ≠ SNI domain-fronting.
2. **`iptables` egress lock**: only the `proxy` UID may originate
   outbound packets; everything else must use the proxy or be dropped.
   IPv6 is default-deny; denied egress is rate-limited-logged
   (`dmesg | grep vision-deny`).

Allowlist (in `squid.conf`): Anthropic + Claude Code, `registry.npmjs.org`,
GitHub, PyPI, Debian/PostgreSQL apt, Yahoo Finance, `*.visualstudio.com`.

> **Everything routes through the proxy.** `HTTP(S)_PROXY` is set, and
> `NODE_USE_ENV_PROXY=1` makes Node ≥24's global `fetch` honor it too — so
> `claude`, `bun`, `npm`, `git`, `gh`, `pip`, and app `fetch` all egress via
> squid. The backend's yahoo-finance calls **work inside the container** now
> (those hosts are allowlisted). To change the allowlist, edit `squid.conf`
> and **rebuild** (it's baked into the image).

squid is supervised by the entrypoint: if it crashes, it's restarted
(egress stays denied while down — fail-closed).

**Supply-chain scanning.** `post-create` installs Aikido safe-chain and
`BASH_ENV` wires it into every shell, so `npm`/`bun`/`pip` installs are
screened against `malware-list.aikido.dev` before running. Defense-in-depth
on top of the sandbox.

**Observability.** Blocked egress shows as a TLS/cert error or
`CONNECT 403` — that's the policy denying it. The definitive log is
`/var/log/squid/access.log` (`dev`-readable; `TCP_DENIED`/`NONE` = blocked).
`dmesg | grep vision-deny` catches proxy-bypass attempts but needs root.
Run `.devcontainer/bin/doctor` for a one-shot readiness check.

**Not covered:** WebSearch/WebFetch run Anthropic-side, not through the
proxy. ECH (encrypted SNI) destinations fail closed (no SNI → terminated).

**Caps:** drops all Linux caps, re-adds only `NET_ADMIN, CHOWN,
DAC_OVERRIDE, FOWNER, SETUID, SETGID, SETPCAP` (entrypoint iptables/perms/
Postgres + squid privilege-drops). Add to `runArgs` if new tooling needs more.

**Prereqs / portability:** The container is allocated 4 GB RAM (`-m 4g`).
**macOS/apple-container only** — the Keychain auth doesn't exist on Linux; export
`CLAUDE_CODE_OAUTH_TOKEN` there instead. No git credential or ssh-agent is
forwarded (see "Git" below), so `~/.ssh` and a `*-gh-token` are no longer needed.

## Persistence

| Source | Container path | Type | Holds |
| --- | --- | --- | --- |
| `.devcontainer` (host) | `/workspaces/Vision/.devcontainer` | bind **RO** | Overlay on the rw workspace so the sandbox config + host launcher can't be rewritten from inside (see Safety note) |
| `vision-claude` | `/home/dev/.claude` | named volume | Container's writable Claude config — seeded from the sanitized stage on first create |
| `~/.claude-sandbox/stage/vision` (host) | `/home/dev/.claude-stage` | bind **RO** | Sanitized staging copy the wrapper produces (secrets + `hooks`/`mcpServers`/`enabledPlugins` stripped). Raw host `~/.claude` is **never** mounted. |
| (container fs) | `/home/dev/.claude.json` | regular file | Container's writable global config, seeded from `…/claude.json` in the stage |
| `vision-pgdata` | `/var/lib/postgresql` | named volume | Postgres data dir |

The Vision repo is bind-mounted at `/workspaces/Vision`, so edits appear
on the host immediately. The Claude config is **not** live-shared (that
corrupts `~/.claude.json` under concurrent writes, and a raw bind would
expose host secrets): the container gets its own writable copy seeded
from the sanitized stage, refreshed read-only on each start. No `gh`/git
token is forwarded at all — git inside the container is read-only (see "Git").

## Syncing Claude config between host and container

The fish function `vision-claude-sync` propagates Claude config
(settings, rules, plugins, agents, slash commands, hooks, MCP server
definitions, session history) between your host `~/.claude` and the
container's `~/.claude`. It's a manual command — nothing runs
continuously in the background — so corruption-by-concurrent-write
isn't possible.

```sh
vision-claude-sync pull     # refresh container from host (also auto-runs on launch)
vision-claude-sync push     # propagate container changes back to host (also auto-runs on session exit)
vision-claude-sync status   # show what differs
```

Both `pull` and `push` use `rsync --update` (per-file newer-wins) and a
`jq` recursive merge for `.claude.json` (container values win on key
conflict, so pulls add new host keys without clobbering container edits;
pushes overwrite host values with container's). No deletes — files
removed on one side stay on the other until manually cleaned up.

### Auto-pull on container start

The `vision-claude` wrapper re-stages a sanitized copy of host
`~/.claude` into `~/.claude-sandbox/stage/vision` on every invocation, and
`post-start.sh` runs `rsync --update` from `/home/dev/.claude-stage` into
`/home/dev/.claude` on every container start. So host-side config changes
(new agents, edited rules) are picked up automatically. Note: `hooks`,
`mcpServers`, and `enabledPlugins` are stripped during staging — re-add
them inside the container if you want them active there.

Pull-on-start is safe under concurrency: it only reads from the stage, so
there's no write race against a host-side claude session.

### Push on session exit (automatic)

The reverse (container → host) now runs automatically. The `vision-claude`
wrapper no longer `exec`s the session — it stays the parent process and, on
**session exit** (normal or Ctrl-C), runs `vision-claude-sync push` against the
exact container it launched. So if Claude inside the container modifies its own
config — adds an agent, edits a rule, registers an MCP, writes a memory — those
changes land back on the host with no manual step. Pushing only after the
session ends keeps a single writer, so it can't race a live host-side claude on
`~/.claude.json`. Disable with `VISION_AUTOSYNC=0`; `vision-claude-sync push`
remains the manual fallback (e.g. after a crash, or to retry a failed auto-push).

**Files excluded from sync** (volatile runtime state, not portable):
`.credentials.json`, `backups/`, `cache/`, `paste-cache/`, `daemon.log`,
`debug/`, `telemetry/`, `session-env/`, `shell-snapshots/`.

**Push safety.** Every push backs up `~/.claude.json` to
`~/.claude.json.pre-push.<timestamp>` before merging. Roll back with:
```sh
mv ~/.claude.json.pre-push.<timestamp> ~/.claude.json
```

The function ships at `~/.config/fish/functions/vision-claude-sync.fish`.

**Auth — threat-model conscious version.** Your host Claude credentials
live in the macOS Keychain (encrypted, ACL-protected, prompts on access).
The in-container browser login is broken upstream (redirect URI gets
double-encoded as `oauth%2Fcode/callback` and the OAuth provider rejects
it). To avoid writing any long-lived credential to a plaintext file on
disk, we store the container's token in Keychain too, and the wrapper
retrieves it at exec time and forwards it as an env var to the
container — credentials only ever land in Keychain or in container
process memory, never in a file.

**One-time setup, on the host:**

```sh
# 1) Generate a long-lived OAuth token (uses your existing subscription).
claude setup-token
# → prints a token starting with sk-ant-…   copy it

# 2) Store it in Keychain under a service name the wrapper looks for.
security add-generic-password \
  -s "vision-claude-code-token" \
  -a "$USER" \
  -w   # prompts you to paste the token (won't echo)
```

That's it. The `vision-claude` wrapper now does
`security find-generic-password -s vision-claude-code-token -w` on every
invocation and forwards the result to the container via
`container exec -e CLAUDE_CODE_OAUTH_TOKEN=…`. No plaintext
file, no fish universal var, no `.credentials.json` in `~/.claude`.

**The Keychain "Always Allow" decision.** The first time `security` reads
this entry, macOS will pop the standard Keychain prompt. Your choices:

- **Allow** → token released to this invocation only; you'll see the
  prompt again next time. Highest friction, lowest risk: any other
  process trying to grab the token has to either trigger a visible
  prompt or impersonate `security` plausibly enough to fool you.
- **Always Allow** → grants the `security` binary blanket access. No
  more prompts, but any process running as your user can shell out to
  `security` and get the token without you noticing. Convenience at the
  cost of one of the layers Keychain was buying you.

For your stated threat model (worry about host compromise → stolen
credentials), **Allow each time is the more defensible choice.** If you
later get tired of clicking, you can change your mind via Keychain
Access.app → find the entry → Access Control → swap.

**Rotating.** When you want to invalidate the token:

```sh
security delete-generic-password -s "vision-claude-code-token"
# then re-run the two-step setup above with a fresh `claude setup-token`
```

**Fallback paths (still supported by the wrapper).** If you'd rather
skip the Keychain dance, the wrapper also picks up
`CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`
straight from your shell env. Worse posture (plaintext in
`~/.config/fish/fish_variables`), but functional.

## Git (read-only inside; commit & push on the host)

The container can **read** git history but cannot change it. The repo's `.git`
is bind-mounted **read-only**, no git credential (`GH_TOKEN`/`GITHUB_TOKEN`) is
forwarded, and the host ssh-agent is **not** forwarded. So a compromised agent
can't rewrite history, push, or sign/authenticate as you over SSH.

| Operation | Works? | Notes |
| --- | --- | --- |
| `git status` / `diff` / `log` / `show` | ✅ | Read-only on the bind-mounted repo (`safe.directory` is set) |
| `git commit` / `rebase` / `reset` / `amend` | ❌ | `.git` is read-only — fails with EROFS, by design |
| `git push` / `gh pr create` | ❌ | No credential in the container; `git push` errors with "could not read Username" |
| commit signing (ssh-agent) | ❌ (n/a) | No ssh-agent forwarded; nothing to sign with — commits happen on the host |

**Workflow:** make changes inside the container (they appear on the host via the
bind mount immediately), then **commit and push from your host** where your
gitconfig, signing key, and gh auth live. There is no in-container git auth to
set up.

## Known limitations

- **App `fetch` to non-allowlisted hosts** — works for allowlisted hosts
  via `NODE_USE_ENV_PROXY=1` (e.g. yahoo-finance reaches `*.finance.yahoo.com`
  through the proxy); anything not in `squid.conf`'s allowlist is denied.
- **Puppeteer (PDF rendering)** — Chromium isn't preinstalled. If you
  need PDF rendering in dev, run `bunx playwright install chromium --with-deps`
  once and set `PUPPETEER_EXECUTABLE_PATH`.
- **Electron `.dmg` build (`bun run dist`)** — needs macOS native tools;
  run on the host, not in this container.
- **Changing the egress allowlist** — edit `squid.conf` and rebuild
  (it's baked into the image, not read from the workspace).
- **Host Ollama** — blocked; add the host's address to the `squid.conf`
  allowlist and rebuild if you want it through.

## Verified isolation + functionality

| Check | Result |
| --- | --- |
| Read `/Users/<you>` on host from container | ❌ blocked — only `/workspaces/Vision` is mounted |
| Connect to host's `host.docker.internal:5432` | ❌ firewall drops |
| Connect to host gateway `172.17.0.1:22` | ❌ firewall drops |
| Reach `api.anthropic.com`, `github.com`, `registry.npmjs.org` | ✅ |
| Reach `example.com` / direct egress bypassing the proxy | ❌ blocked (proxy terminates / firewall drops) |
| `claude -p` API call through the proxy | ✅ |
| Postgres role/db created by the entrypoint | ✅ `ftm_user` / `financial_transactions` |
| `dev` can `sudo` or modify iptables | ❌ no sudo; `no-new-privileges` |
| File written from container appears on host (bind-mount) | ✅ |
| `git log`/`diff` (read-only) | ✅ |
| `git commit` / `push` from inside the container | ❌ `.git` is RO + no credential — commit/push on the host |
| Host browser hits `http://localhost:8080` | ✅ |

## Safety note

The container runs as a non-root user (`dev`), so the CLI accepts
`--dangerously-skip-permissions`. Anthropic still warns: a malicious
project can exfiltrate anything inside the container, including the
`~/.claude` credentials volume. Treat this as *"host is isolated from
Claude,"* not *"Claude is isolated from a hostile repo."* Only enable
for trusted repositories.

**Why `.devcontainer` is mounted read-only.** The repo is bind-mounted
read-write at `/workspaces/Vision` so the agent can edit source — but that
same mount would otherwise expose the sandbox's own definition
(`Dockerfile`) and the **host-side launcher**
(`bin/claude`, `bin/doctor`), which run on your **Mac** with your shell and
Keychain. A compromised in-container agent could edit `bin/claude` or the
`Dockerfile`, and the next `claude` invocation (which calls `container build`
and re-execs the launcher) would run it on the host — a trivial full escape.
To close that, `.devcontainer` is re-mounted **read-only on top of** the
read-write workspace, so it is immutable from inside. The container cannot lift
this: it has `cap-drop=ALL` (no `CAP_SYS_ADMIN`, so no remount/unmount), and
`.devcontainer` is a busy mountpoint that can't be replaced — the protection
re-applies on every `container run`. **Edit `.devcontainer` on the host only,**
then rebuild.
