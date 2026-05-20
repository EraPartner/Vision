# Vision devcontainer

Hardened dev environment for working on Vision with the Claude CLI in
`--dangerously-skip-permissions` mode. The entire dev stack — Postgres,
backend, frontend — runs natively inside this container, so there is no
Docker-in-Docker.

## What's inside

| Component | Where it runs | Port |
| --- | --- | --- |
| PostgreSQL 18 | Native (apt) — same major as `docker-compose.yml` | `5432` (in-container only) |
| Backend (bun + Express) | `bun run dev` | `3002` published to `127.0.0.1` |
| Frontend (Vite) | `bun run dev` | `8080` published to `127.0.0.1` |
| Alembic migrations | Python venv at `./venv` | — |
| GitHub CLI (`gh`) | apt | — |
| Claude Code | Installed via the official `claude-code` devcontainer feature | — |

The base image is plain `debian:bookworm-slim`. The container user is
`dev` (UID 1000).

## How to use — CLI only

Prerequisite (one-time): `npm install -g @devcontainers/cli`.

A wrapper at `.devcontainer/bin/claude` forwards every invocation into
the container (idempotent `devcontainer up` + `devcontainer exec`).

**Fish function on this machine** (lives at
`~/.config/fish/functions/vision-claude.fish`):

```fish
function vision-claude --description 'Run claude inside the Vision devcontainer'
    set -l project ""
    set -l current $PWD
    while test "$current" != "/" -a "$current" != ""
        if test -f "$current/.devcontainer/devcontainer.json"
            set project $current; break
        end
        set current (dirname $current)
    end
    if test -z "$project"
        set project (set -q VISION_HOME; and echo $VISION_HOME; or echo "/Users/computer/Documents/Personal/Scripts/Projects/Vision")
    end
    if not test -x "$project/.devcontainer/bin/claude"
        echo "vision-claude: wrapper missing at $project/.devcontainer/bin/claude" >&2
        return 1
    end
    VISION_PROJECT_ROOT=$project "$project/.devcontainer/bin/claude" $argv
end
```

Then anywhere: `vision-claude --dangerously-skip-permissions`. Works from
inside the repo (walk-up), from a subdir, and from unrelated dirs
(fallback to `$VISION_HOME`).

To drop into a shell instead of Claude:
```sh
devcontainer exec --workspace-folder /Users/computer/Documents/Personal/Scripts/Projects/Vision bash
```

## Browser access from the host

`devcontainer.json:runArgs` includes `--publish=127.0.0.1:8080:8080` and
`--publish=127.0.0.1:3002:3002`. Once Claude (or you) runs `bun run dev`
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

**Prereqs / portability:** `~/.gitconfig` and `~/.ssh/github.pub` must exist
on the host (bind-mounted RO; missing → opaque `devcontainer up` failure).
Docker Desktop VM needs ≥4 GB. **macOS/Docker-Desktop only** — the Keychain
auth and `/run/host-services/ssh-auth.sock` mount don't exist on Linux/Colima/
OrbStack; drop that mount and export `CLAUDE_CODE_OAUTH_TOKEN`/`GH_TOKEN`
there. Use a **fine-grained PAT scoped to this repo** for `vision-gh-token`
(it's inherited by Claude's subprocesses + GitHub is allowlisted).

## Persistence

| Source | Container path | Type | Holds |
| --- | --- | --- | --- |
| `vision-claude-<id>` | `/home/dev/.claude` | named volume | Container's writable Claude config — seeded from the sanitized stage on first create |
| `~/.claude-vision-stage` (host) | `/home/dev/.claude-stage` | bind **RO** | Sanitized staging copy the wrapper produces (secrets + `hooks`/`mcpServers`/`enabledPlugins` stripped). Raw host `~/.claude` is **never** mounted. |
| (container fs) | `/home/dev/.claude.json` | regular file | Container's writable global config, seeded from `…/claude.json` in the stage |
| `vision-pgdata-<id>` | `/var/lib/postgresql` | named volume | Postgres data dir |

The Vision repo is bind-mounted at `/workspaces/Vision`, so edits appear
on the host immediately. The Claude config is **not** live-shared (that
corrupts `~/.claude.json` under concurrent writes, and a raw bind would
expose host secrets): the container gets its own writable copy seeded
from the sanitized stage, refreshed read-only on each start. The `gh`
token is **not** persisted — it's forwarded from the host Keychain
(`vision-gh-token`) at exec time.

## Syncing Claude config between host and container

The fish function `vision-claude-sync` propagates Claude config
(settings, rules, plugins, agents, slash commands, hooks, MCP server
definitions, session history) between your host `~/.claude` and the
container's `~/.claude`. It's a manual command — nothing runs
continuously in the background — so corruption-by-concurrent-write
isn't possible.

```sh
vision-claude-sync pull     # refresh container from host (also auto-runs on container start)
vision-claude-sync push     # propagate container changes back to host (manual; required)
vision-claude-sync status   # show what differs
```

Both `pull` and `push` use `rsync --update` (per-file newer-wins) and a
`jq` recursive merge for `.claude.json` (container values win on key
conflict, so pulls add new host keys without clobbering container edits;
pushes overwrite host values with container's). No deletes — files
removed on one side stay on the other until manually cleaned up.

### Auto-pull on container start

The `vision-claude` wrapper re-stages a sanitized copy of host
`~/.claude` into `~/.claude-vision-stage` on every invocation, and
`post-start.sh` runs `rsync --update` from `/home/dev/.claude-stage` into
`/home/dev/.claude` on every container start. So host-side config changes
(new agents, edited rules) are picked up automatically. Note: `hooks`,
`mcpServers`, and `enabledPlugins` are stripped during staging — re-add
them inside the container if you want them active there.

Pull-on-start is safe under concurrency: it only reads from the stage, so
there's no write race against a host-side claude session.

### Push remains explicit

The reverse (container → host) is **not** automatic. If Claude inside
the container modifies its own config — adds an agent, edits a rule,
registers an MCP — those changes live only in the container volume
until you run `vision-claude-sync push`.

`.claude/CLAUDE.md` instructs in-container Claude to remind the user to
push at end-of-turn whenever it edits `~/.claude/` or `~/.claude.json`,
so you shouldn't have to remember unprompted.

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
`devcontainer exec --remote-env CLAUDE_CODE_OAUTH_TOKEN=…`. No plaintext
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

## Git, GitHub, signed commits

| Operation | Works? | Notes |
| --- | --- | --- |
| `git status` / `diff` / `log` | ✅ | Read-only on the bind-mounted repo |
| `git branch` / `switch` / `checkout` | ✅ | Local refs only |
| `git commit -S` (SSH-signed) | ✅ | Public key bind-mounted from host; private key never enters the container — signing goes through the forwarded ssh-agent (`/run/host-services/ssh-auth.sock`). Make sure your agent is unlocked on the host. |
| `git push` over HTTPS | ✅ | `GH_TOKEN` forwarded from Keychain; `github.com` allowlisted |
| `gh pr create`, `gh issue …` | ✅ | Uses the forwarded `GH_TOKEN`; no `gh auth login` needed |
| `git push` / `git@github.com` (SSH transport) | ❌ by default | `~/.ssh` is not mounted; ssh-agent socket is the only key channel. Use HTTPS push. |

**One-time GitHub auth (host Keychain, no token in the container):**

```sh
gh auth token | security add-generic-password -s vision-gh-token -a "$USER" -w
# or paste a fine-grained PAT instead of `gh auth token`
```

The wrapper forwards it as `GH_TOKEN`/`GITHUB_TOKEN` at exec time — no `gh`
config volume, no token on disk in the container.

**How signing works here.** Your host `~/.gitconfig` is bind-mounted read-only
at `~/.gitconfig-host` and included from an in-container `~/.gitconfig`,
so `user.name`, `user.email`, `commit.gpgsign`, and `gpg.format = ssh`
all carry over. The override sets `user.signingkey` to the in-container
path of the bind-mounted public key. When `git commit -S` runs,
ssh-keygen queries `SSH_AUTH_SOCK` (= `/ssh-agent`, the forwarded host
ssh-agent socket) for a private key matching the public key — it never
sees the private key file directly.

**Prerequisite on your host:** the signing private key must actually be
loaded in your host ssh-agent before you `vision-claude`. If it isn't,
`post-start.sh` prints a diagnostic showing the expected fingerprint vs.
what's in the agent, with the exact `ssh-add` command to fix it.

```sh
# on the host, once per agent lifetime / login session
ssh-add ~/.ssh/github
```

If you use macOS Keychain ssh-agent, add to `~/.ssh/config`:

```
Host *
    UseKeychain yes
    AddKeysToAgent yes
```

so the key auto-loads on first use and survives reboots.

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
- **Host Ollama via `host.docker.internal`** — blocked; add it to the
  `squid.conf` allowlist and rebuild if you want it through.

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
| `git commit -S` (SSH-signed, via forwarded agent) | ✅ |
| `gh`/`git push` via forwarded `GH_TOKEN` | ✅ no `gh auth login` |
| Host browser hits `http://localhost:8080` | ✅ |

## Safety note

The container runs as a non-root user (`dev`), so the CLI accepts
`--dangerously-skip-permissions`. Anthropic still warns: a malicious
project can exfiltrate anything inside the container, including the
`~/.claude` credentials volume. Treat this as *"host is isolated from
Claude,"* not *"Claude is isolated from a hostile repo."* Only enable
for trusted repositories.
