# Vision devcontainer — runs the full dev stack (Postgres + backend + frontend)
# natively inside the container, so we don't need Docker-in-Docker.
#
# Plain Debian base with a `dev` user (UID 1000). Nothing here depends on
# any editor; the only consumer is the Claude CLI.
#
# Tools installed by features (devcontainer.json): node, python, claude-code.
# Tools installed here: postgresql-18, bun, gh, firewall plumbing, build basics.

FROM debian:bookworm-slim

ARG TZ=UTC
ENV TZ="$TZ"
ENV DEBIAN_FRONTEND=noninteractive

# Base utilities + a non-root `dev` user (UID 1000) so the bind-mounted
# workspace ownership lines up with the host user. sudo is installed but
# restricted to a narrow allowlist further down.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg lsb-release \
      git sudo less procps jq locales openssh-client unzip rsync \
      iptables ipset dnsutils \
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

# PostgreSQL 18 from the official PGDG repo so the major version matches
# docker-compose.yml (postgres:18-alpine).
RUN install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo $VERSION_CODENAME)-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends \
       postgresql-18 \
  && rm -rf /var/lib/apt/lists/*
# Keep the postinst-created cluster. On first container start Docker seeds
# the empty pgdata volume from /var/lib/postgresql in the image, so the
# cluster carries over and survives container recreations.

# Bun (latest stable — the repo's bun.lock uses the text format that bun >= 1.2 emits).
RUN curl -fsSL https://bun.sh/install | bash \
  && mv /root/.bun/bin/bun /usr/local/bin/bun \
  && chmod +x /usr/local/bin/bun \
  && rm -rf /root/.bun

# Sudo: narrow allowlist. Grants `dev` no blanket root access, only the
# specific commands post-create / post-start / firewall scripts need.
RUN printf '%s\n' \
      'dev ALL=(postgres) NOPASSWD: ALL' \
      'dev ALL=(root) NOPASSWD: /usr/bin/pg_ctlcluster, /usr/bin/pg_createcluster, /usr/bin/pg_dropcluster, /usr/sbin/iptables, /usr/sbin/iptables-restore, /usr/sbin/iptables-save, /usr/sbin/ip6tables, /usr/sbin/ipset, /usr/sbin/service, /workspaces/Vision/.devcontainer/init-firewall.sh, /bin/chown, /bin/chmod' \
      > /etc/sudoers.d/dev-vision \
  && chmod 0440 /etc/sudoers.d/dev-vision \
  && visudo -c -f /etc/sudoers.d/dev-vision

# `dev` needs the postgres group to read /var/lib/postgresql when we
# start the cluster from post-create.
RUN usermod -aG postgres dev

# postgres data root must be writable by the postgres user on volume mount.
RUN mkdir -p /var/lib/postgresql && chown postgres:postgres /var/lib/postgresql

# Pre-create ~/.ssh with strict perms so the signing-key bind-mount lands
# in a dev-owned dir (ssh-keygen rejects loose perms on .ssh).
RUN install -d -o dev -g dev -m 0700 /home/dev/.ssh

USER dev
WORKDIR /workspaces/Vision
