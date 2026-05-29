# Vision sandbox image — devcontainer-FREE (built by docker compose).
#
# Self-contained twin of ./Dockerfile. The devcontainer build relied on
# devcontainer FEATURES (node:1, python:1, anthropics/claude-code:1.0) layered by
# the devcontainer CLI; compose has no feature system, so this file installs
# Node + Python + the Claude CLI itself. Everything else (Postgres, Bun,
# hardening, egress proxy, baked scripts) is identical to Dockerfile.
#
# Hardened for Claude CLI in --dangerously-skip-permissions mode:
#   - --security-opt=no-new-privileges (no sudo, no setuid escalation)
#   - a root ENTRYPOINT does all privileged setup (perms, Postgres, proxy,
#     firewall), then drops to a keep-alive
#   - all egress forced through an in-container squid proxy (hostname allowlist)

FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb

ARG TZ=UTC
ENV TZ="$TZ"
ENV DEBIAN_FRONTEND=noninteractive

# Base utilities + a non-root `dev` user (UID 1000). sudo intentionally absent.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release xz-utils \
      git less procps jq locales openssh-client unzip rsync \
      iptables dnsutils openssl \
      squid-openssl \
      build-essential pkg-config libpq-dev \
      postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash dev \
  && echo "C.UTF-8 UTF-8" > /etc/locale.gen && locale-gen

# GitHub CLI from the official cli.github.com apt repo.
RUN install -d -m 0755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# PostgreSQL 18 from the official PGDG repo (matches docker-compose.yml).
RUN install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-18 \
  && rm -rf /var/lib/apt/lists/*

# Bun, pinned to a versioned GitHub release with SHA256 verification.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      arm64) BUN_ARCH=aarch64; BUN_SHA=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;; \
      amd64) BUN_ARCH=x64;     BUN_SHA=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f ;; \
      *) echo "unsupported arch"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-${BUN_ARCH}.zip"; \
    echo "${BUN_SHA}  /tmp/bun.zip" | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    mv "/tmp/bun/bun-linux-${BUN_ARCH}/bun" /usr/local/bin/bun; \
    chmod +x /usr/local/bin/bun; \
    rm -rf /tmp/bun /tmp/bun.zip

# --- Node.js (replaces the `node:1` feature) — official static build ---------
ARG NODE_VERSION=24.15.0
RUN set -eux; \
    case "$(dpkg --print-architecture)" in amd64) na=x64 ;; arm64) na=arm64 ;; *) exit 1 ;; esac; \
    curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${na}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
      --exclude='*/CHANGELOG.md' --exclude='*/LICENSE' --exclude='*/README.md'; \
    rm /tmp/node.tar.xz; \
    mkdir -p /usr/local/share/npm-global

# --- Python 3.12 (replaces the `python:1` feature) — python-build-standalone --
# The feature compiled CPython from source; we use the prebuilt relocatable
# CPython (the same builds uv/rye use). python3 + pip + venv + ssl, no compile.
# Downloaded DIRECTLY from a pinned release asset, NOT resolved via the GitHub API:
# the unauthenticated api.github.com 60-req/hr limit gets exhausted when several
# images build in a row, returning 403 and failing the build (curl exit 22). Asset
# downloads from the releases/download host don't count against that limit.
# Bump by editing PY_RELEASE/PY_VERSION (asset = cpython-<ver>+<release>-<arch>...).
ARG PY_RELEASE=20260510
ARG PY_VERSION=3.12.13
RUN set -eux; \
    case "$(dpkg --print-architecture)" in arm64) pa=aarch64 ;; amd64) pa=x86_64 ;; *) exit 1 ;; esac; \
    url="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/cpython-${PY_VERSION}+${PY_RELEASE}-${pa}-unknown-linux-gnu-install_only.tar.gz"; \
    echo "python-build-standalone: $url"; \
    curl -fsSLo /tmp/py.tar.gz "$url"; \
    mkdir -p /opt/python; \
    tar -xzf /tmp/py.tar.gz --strip-components=1 -C /opt/python; \
    rm /tmp/py.tar.gz; \
    [ -x /opt/python/bin/python ] || ln -s python3 /opt/python/bin/python; \
    /opt/python/bin/python3 --version; /opt/python/bin/python3 -m venv --help >/dev/null

# python-build-standalone bakes CC=clang into its sysconfig, so building any C
# extension (e.g. psycopg2, which ships no wheels) invokes clang — absent here;
# this image carries gcc via build-essential. Pin CC to gcc so source builds
# work (setuptools rewrites LDSHARED clang->gcc off CC, so linking follows too).
# Without this, `pip install psycopg2` aborts post-create before it seeds
# ~/.claude, and Claude starts unconfigured. Covers mid-session pip builds too.
ENV CC=gcc CXX=g++

# Global npm prefix -> a dev-owned dir so runtime `npm i -g` (safe-chain) works.
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=/usr/local/share/npm-global/bin:/opt/python/bin:/usr/local/bin:$PATH
# Login shells reset PATH via /etc/profile; re-add the tool dirs for them too.
RUN printf 'export PATH="/usr/local/share/npm-global/bin:/opt/python/bin:/usr/local/bin:$PATH"\n' \
      > /etc/profile.d/00-sandbox-path.sh

# --- Claude Code CLI (replaces the `anthropics/claude-code:1.0` feature) -----
RUN npm install -g @anthropic-ai/claude-code@2.1.156 \
  && claude --version \
  && chown -R dev:dev /usr/local/share/npm-global

# Bake privileged scripts into the image (root-owned, source-only repo copies).
COPY init-firewall.sh /usr/local/sbin/egress-firewall
COPY perms-fix.sh     /usr/local/sbin/vision-perms-fix
COPY entrypoint.sh    /usr/local/sbin/vision-entrypoint
COPY squid.conf       /etc/squid/squid.conf
COPY allowlist.txt    /etc/squid/allowlist.txt
RUN chmod 0755 /usr/local/sbin/egress-firewall /usr/local/sbin/vision-perms-fix /usr/local/sbin/vision-entrypoint \
  && chown root:root /usr/local/sbin/egress-firewall /usr/local/sbin/vision-perms-fix /usr/local/sbin/vision-entrypoint

# Launch-integrity check (the binary fingerprint manifest is baked below).
COPY bin/verify-pins /usr/local/bin/vision-verify-pins
RUN chmod 0755 /usr/local/bin/vision-verify-pins

# Inbound ports this project publishes (read by egress-firewall for INPUT ACCEPT).
RUN mkdir -p /etc/egress && printf '8080\n3002\n' > /etc/egress/inbound-ports

# Pre-build the squid TLS-bump cert + cert DB (entrypoint regenerates if missing).
RUN mkdir -p /etc/squid/certs /var/lib/squid /var/log/squid /var/spool/squid \
  && openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
       -subj "/CN=vision-egress-proxy" \
       -keyout /etc/squid/certs/bump.key -out /etc/squid/certs/bump.crt \
  && cat /etc/squid/certs/bump.key /etc/squid/certs/bump.crt > /etc/squid/certs/bump.pem \
  && chmod 600 /etc/squid/certs/bump.key /etc/squid/certs/bump.pem \
  && /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB \
  && chown -R proxy:proxy /etc/squid/certs /var/lib/squid /var/log/squid /var/spool/squid

# postgres data root must be writable by postgres on volume mount.
RUN mkdir -p /var/lib/postgresql && chown postgres:postgres /var/lib/postgresql

# Pre-create dirs backed by named volumes so a fresh volume inherits dev ownership.
RUN install -d -o dev -g dev -m 0700 /home/dev/.claude \
 && install -d -o dev -g dev -m 0755 /home/dev/.config /home/dev/.config/gh

# Pin the agent's executables: record SHA-256 so vision-verify-pins can
# fail-closed on drift at launch. A legit tool upgrade changes these — rebuild.
RUN set -eux; \
    pinfile=/usr/local/share/vision/binary-pins.txt; \
    mkdir -p /usr/local/share/vision; \
    : > "$pinfile"; \
    for b in node npm claude gh git python3; do \
      p="$(command -v "$b")"; \
      h="$(sha256sum "$p" | awk '{print $1}')"; \
      printf '%s\t%s\t%s\n' "$b" "$p" "$h" >> "$pinfile"; \
    done; \
    chmod 0644 "$pinfile"; \
    cat "$pinfile"

# Strip ALL setuid/setgid bits image-wide (defense-in-depth).
RUN find / -xdev -type f -perm /6000 -exec chmod -s {} + 2>/dev/null || true

WORKDIR /workspaces/Vision

# Health: proxy running, firewall default-deny, Postgres accepting connections.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bash -c 'pgrep -x squid >/dev/null && /usr/sbin/iptables -S OUTPUT 2>/dev/null | grep -q "^-P OUTPUT DROP" && pg_isready -h 127.0.0.1 -p 5432 -q'

ENTRYPOINT ["/usr/local/sbin/vision-entrypoint"]
