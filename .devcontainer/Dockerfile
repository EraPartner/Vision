# Vision devcontainer — runs the full dev stack (Postgres + backend + frontend)
# natively inside the container, so we don't need Docker-in-Docker.
#
# Hardened for Claude CLI in --dangerously-skip-permissions mode:
#   - runs with --security-opt=no-new-privileges (no sudo, no setuid escalation)
#   - a root ENTRYPOINT does all privileged setup (perms, Postgres, proxy,
#     firewall), then drops to a keep-alive; dev sessions have no path to root
#   - all egress is forced through an in-container squid proxy enforcing a
#     HOSTNAME allowlist (peek+splice SNI, no TLS interception)
#
# Tools installed by features (devcontainer.json): node, python, claude-code.

# Pin the base image by digest for reproducibility + supply-chain integrity.
FROM debian:bookworm-slim@sha256:0104b334637a5f19aa9c983a91b54c89887c0984081f2068983107a6f6c21eeb

ARG TZ=UTC
ENV TZ="$TZ"
ENV DEBIAN_FRONTEND=noninteractive

# Base utilities + a non-root `dev` user (UID 1000). NOTE: sudo is intentionally
# NOT installed — the container runs with no-new-privileges and all privileged
# setup happens in the root ENTRYPOINT.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release \
      git less procps jq locales openssh-client unzip rsync \
      iptables dnsutils openssl \
      squid-openssl \
      build-essential pkg-config libpq-dev \
      postgresql-client \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 1000 --shell /bin/bash dev \
  && usermod -aG proxy dev \
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

# Bun, pinned to a versioned GitHub release with SHA256 verification (replaces
# the unverified `curl https://bun.sh/install | bash` supply-chain hole).
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

# Bake privileged scripts into the image at /usr/local/sbin (root-owned, not
# writable from inside the container). Repo copies are source-only — a rewrite
# there can't affect the running container (closes a root-escalation path).
COPY init-firewall.sh /usr/local/sbin/vision-firewall
COPY perms-fix.sh     /usr/local/sbin/vision-perms-fix
COPY entrypoint.sh    /usr/local/sbin/vision-entrypoint
COPY squid.conf       /etc/squid/squid.conf
RUN chmod 0755 /usr/local/sbin/vision-firewall /usr/local/sbin/vision-perms-fix /usr/local/sbin/vision-entrypoint \
  && chown root:root /usr/local/sbin/vision-firewall /usr/local/sbin/vision-perms-fix /usr/local/sbin/vision-entrypoint

# Pre-build the squid TLS-bump cert + cert DB (entrypoint regenerates if missing).
RUN mkdir -p /etc/squid/certs /var/lib/squid /var/log/squid /var/spool/squid \
  && openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
       -subj "/CN=vision-egress-proxy" \
       -keyout /etc/squid/certs/bump.key -out /etc/squid/certs/bump.crt \
  && cat /etc/squid/certs/bump.key /etc/squid/certs/bump.crt > /etc/squid/certs/bump.pem \
  && /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB \
  && chown -R proxy:proxy /etc/squid/certs /var/lib/squid /var/log/squid /var/spool/squid

# postgres data root must be writable by postgres on volume mount (the
# entrypoint's perms-fix is the runtime backstop after the volume mounts).
RUN mkdir -p /var/lib/postgresql && chown postgres:postgres /var/lib/postgresql

# Pre-create ~/.ssh with strict perms for the signing-key bind-mount.
RUN install -d -o dev -g dev -m 0700 /home/dev/.ssh

# Pre-create dirs backed by named volumes so a fresh volume inherits dev
# ownership on first mount (entrypoint perms-fix is the runtime backstop).
RUN install -d -o dev -g dev -m 0700 /home/dev/.claude \
 && install -d -o dev -g dev -m 0755 /home/dev/.config /home/dev/.config/gh

# Container process (PID 1 / entrypoint) runs as root so it can apply iptables,
# start Postgres, and start the proxy; devcontainer.json sets remoteUser=dev for
# sessions and --security-opt=no-new-privileges so dev cannot escalate.
WORKDIR /workspaces/Vision

# Health: the egress proxy must be listening AND Postgres must accept
# connections. start-period covers entrypoint setup. Surfaces in `docker ps`;
# `.devcontainer/bin/doctor` is the fuller manual check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD bash -c '(exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null && pg_isready -h 127.0.0.1 -p 5432 -q'

ENTRYPOINT ["/usr/local/sbin/vision-entrypoint"]
