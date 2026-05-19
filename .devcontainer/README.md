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

`init-firewall.sh` applies an iptables default-deny egress policy on
every container start. Allowlist covers Anthropic / npm / GitHub / PyPI /
Yahoo Finance / Debian-PostgreSQL apt mirrors. DNS is restricted to the
resolver configured in `/etc/resolv.conf` to narrow the DNS-tunneling
surface called out in
[anthropics/claude-code#36907](https://github.com/anthropics/claude-code/issues/36907).

To add another domain, edit `ALLOWED_DOMAINS` in `init-firewall.sh` and
re-run `sudo .devcontainer/init-firewall.sh`.

## Persistence

| Source | Container path | Type | Holds |
| --- | --- | --- | --- |
| `vision-claude-<id>` | `/home/dev/.claude` | named volume | Container's writable Claude config — seeded from host on first create, owned by container thereafter |
| `~/.claude` (host) | `/home/dev/.claude-host` | bind **RO** | Read-only mirror of host's Claude config — used as the source for sync operations |
| `~/.claude.json` (host) | `/home/dev/.claude-json-seed` | bind **RO** | Read-only seed for the container's `~/.claude.json` |
| (container fs) | `/home/dev/.claude.json` | regular file | Container's writable global config, seeded from `.claude-json-seed` on first create |
| `vision-pgdata-<id>` | `/var/lib/postgresql` | named volume | Postgres data dir |
| `vision-ghconfig-<id>` | `~/.config/gh` | named volume | `gh` auth token |

The Vision repo itself is bind-mounted at `/workspaces/Vision`, so file
edits appear on the host immediately. The Claude config, however, is
**not** live-shared — that previously corrupted `~/.claude.json` when
host claude and container claude were running simultaneously. Instead,
the container has its own writable copy seeded from the host once, plus
a read-only mirror of the host config kept around for explicit sync
operations.

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

`post-start.sh` runs `rsync --update` from `/home/dev/.claude-host` into
`/home/dev/.claude` on every container start, including the implicit
`devcontainer up` that the `vision-claude` wrapper does on each
invocation. So host-side config changes (new agents, edited rules,
added MCP servers) are picked up automatically without you running
anything.

Pull-on-start is safe under concurrency: it only reads from host, so
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
| `git push` over HTTPS | ✅ after `gh auth login` | `github.com` is allowlisted; `gh` manages the git credential helper |
| `gh pr create`, `gh issue …` | ✅ after `gh auth login` | `gh` 2.92.0 preinstalled |
| `git push` / `git@github.com` (SSH transport) | ❌ by default | `~/.ssh` is not mounted; ssh-agent socket is the only key channel. Use HTTPS push via `gh`. |

**One-time auth inside the container:**

```sh
gh auth login --web --hostname github.com --git-protocol https
```

The token persists in the `vision-ghconfig-<id>` volume across rebuilds.

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

- **Puppeteer (PDF rendering)** — Chromium isn't preinstalled. If you
  need PDF rendering in dev, run `bunx playwright install chromium --with-deps`
  once and set `PUPPETEER_EXECUTABLE_PATH`.
- **Electron `.dmg` build (`bun run dist`)** — needs macOS native tools;
  run on the host, not in this container.
- **Host Ollama via `host.docker.internal`** — works on Docker Desktop
  but is firewalled out; add to `ALLOWED_DOMAINS` in `init-firewall.sh`
  if you want it through.

## Verified isolation + functionality

| Check | Result |
| --- | --- |
| Read `/Users/<you>` on host from container | ❌ blocked — only `/workspaces/Vision` is mounted |
| Connect to host's `host.docker.internal:5432` | ❌ firewall drops |
| Connect to host gateway `172.17.0.1:22` | ❌ firewall drops |
| Reach `api.anthropic.com`, `github.com`, `registry.npmjs.org` | ✅ |
| Reach `example.com`, `cloudflare.com`, `facebook.com` | ❌ timeout |
| File written from container appears on host (bind-mount) | ✅ |
| Postgres in container as `ftm_user` after migrations | ✅ 44 public tables |
| `bun run dev` boots on canonical ports | ✅ `:3002` + `:8080` |
| `claude --version` | ✅ `2.1.144` |
| `git commit -S` (SSH-signed, via forwarded agent) | ✅ |
| `gh api /rate_limit` after `gh auth login` | ✅ |
| Host browser hits `http://localhost:8080` | ✅ |

## Safety note

The container runs as a non-root user (`dev`), so the CLI accepts
`--dangerously-skip-permissions`. Anthropic still warns: a malicious
project can exfiltrate anything inside the container, including the
`~/.claude` credentials volume. Treat this as *"host is isolated from
Claude,"* not *"Claude is isolated from a hostile repo."* Only enable
for trusted repositories.
