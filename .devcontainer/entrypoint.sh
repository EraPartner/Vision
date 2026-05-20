#!/usr/bin/env bash
# /usr/local/sbin/vision-entrypoint
#
# Runs as root (containerUser=root in devcontainer.json) on every container
# start, BEFORE any dev session. Does all privileged setup here so the
# container can run with --security-opt=no-new-privileges (dev sessions then
# have no path to root — no sudo, no setuid).
#
# Order: perms repair -> LOCK EGRESS (firewall, fail-closed) -> start Postgres
# -> start the egress proxy -> keep-alive PID 1. The firewall goes up before
# anything can touch the network, so there's no boot window where a racing
# post-create install could egress unfiltered.
#
# Best-effort and non-fatal: the container must always reach the keep-alive so
# you can exec in and diagnose even if something failed.

set -uo pipefail

log() { echo "[entrypoint] $*"; }

PG_VERSION=18
PG_CLUSTER=main
PG_DATA="/var/lib/postgresql/${PG_VERSION}/${PG_CLUSTER}"
PG_CONF_DIR="/etc/postgresql/${PG_VERSION}/${PG_CLUSTER}"

# 1) Repair ownership of named-volume mountpoints + ssh-agent socket
#    (chowns pgdata->postgres, .claude/.config->dev, ssh-agent->dev:0600).
/usr/local/sbin/vision-perms-fix || log "WARN: perms-fix returned non-zero."

# Network pre-flight: if Docker Desktop detached us from the bridge, the proxy
# can't resolve upstreams. Warn with the fix; still lock the firewall.
has_iface=0
for iface in /sys/class/net/eth*; do [[ -e "$iface" ]] && has_iface=1; done
default_route=$(awk 'NR>1 && $2=="00000000" {print $1; exit}' /proc/net/route 2>/dev/null)
if (( ! has_iface )) || [[ -z "$default_route" ]]; then
  cat >&2 <<EOF
[entrypoint] ⚠  No external network interface / default route.
[entrypoint]    The proxy won't resolve upstreams until this is fixed.
[entrypoint]    On your HOST shell:  docker network connect bridge $HOSTNAME
[entrypoint]    Then restart the container.
EOF
fi

# 2) LOCK EGRESS FIRST (default-deny + proxy-UID-only), before Postgres/squid or
#    anything else touches the network. fail-closed: see init-firewall.sh.
/usr/local/sbin/vision-firewall || log "WARN: firewall apply returned non-zero (egress stays default-DROP)."

# 3) Postgres: start the cluster (init/adopt/create), then ensure role + db.
#    runuser drops to postgres without setuid (works because we are root).
if [[ -f "${PG_CONF_DIR}/postgresql.conf" ]]; then
  log "Registered Postgres cluster found, starting..."
  pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" start || true
elif runuser -u postgres -- test -s "${PG_DATA}/PG_VERSION"; then
  log "Adopting existing Postgres data dir..."
  pg_createcluster "${PG_VERSION}" "${PG_CLUSTER}" --datadir="${PG_DATA}" --start || true
else
  log "Creating fresh Postgres cluster..."
  pg_createcluster "${PG_VERSION}" "${PG_CLUSTER}" --start || true
fi

for _ in $(seq 1 30); do
  pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1 && break
  sleep 1
done

if pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  runuser -u postgres -- psql -v ON_ERROR_STOP=1 >/dev/null 2>&1 <<'SQL' || log "WARN: role ensure failed."
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='ftm_user') THEN
    CREATE ROLE ftm_user LOGIN PASSWORD 'localdev';
  END IF;
END$$;
SQL
  if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='financial_transactions'" 2>/dev/null | grep -q 1; then
    runuser -u postgres -- createdb -O ftm_user financial_transactions || log "WARN: createdb failed."
  fi
  log "Postgres ready (db financial_transactions, role ftm_user)."
else
  log "WARN: Postgres did not become ready."
fi

# 4) Ensure squid TLS-bump cert + cert DB exist, then start the proxy (it
#    egresses as the proxy UID, which the firewall above permits).
if [[ ! -f /etc/squid/certs/bump.pem ]]; then
  log "Generating squid bump cert..."
  mkdir -p /etc/squid/certs
  openssl req -new -newkey rsa:2048 -days 3650 -nodes -x509 \
    -subj "/CN=vision-egress-proxy" \
    -keyout /etc/squid/certs/bump.key -out /etc/squid/certs/bump.crt >/dev/null 2>&1
  cat /etc/squid/certs/bump.key /etc/squid/certs/bump.crt > /etc/squid/certs/bump.pem
fi
if [[ ! -d /var/lib/squid/ssl_db ]]; then
  log "Initializing squid ssl_db..."
  mkdir -p /var/lib/squid
  /usr/lib/squid/security_file_certgen -c -s /var/lib/squid/ssl_db -M 4MB >/dev/null 2>&1 || \
    log "WARN: ssl_db init failed."
fi
mkdir -p /var/log/squid /var/spool/squid
chown -R proxy:proxy /etc/squid/certs /var/lib/squid /var/log/squid /var/spool/squid 2>/dev/null || true

log "Starting egress proxy (squid)..."
squid -N >/var/log/squid/boot.log 2>&1 &
for _ in $(seq 1 20); do
  if (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null; then log "Proxy listening on 127.0.0.1:3128."; break; fi
  sleep 1
done

# Graceful shutdown on `docker stop` (SIGTERM): stop Postgres (fast) and squid
# cleanly so the next start doesn't trigger crash recovery. (With "init": true
# in devcontainer.json, tini reaps zombies and forwards this signal here.)
shutdown() {
  log "shutting down..."
  pg_ctlcluster "${PG_VERSION}" "${PG_CLUSTER}" stop -m fast 2>/dev/null || true
  squid -k shutdown 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

log "Setup complete. Container ready (dev sessions via 'devcontainer exec')."

# 5) Keep PID 1 alive AND supervise the egress proxy. If squid dies mid-session
#    all egress stops (fail-closed) — restart it so it self-heals. The firewall
#    is independent and stays in force while the proxy is down, so this never
#    opens a gap; it only restores the allowlisted path. Process-existence check
#    (pgrep) — not a socket connect — so it doesn't spam the squid access log.
squid_restarts=0
while true; do
  if ! pgrep -x squid >/dev/null 2>&1; then
    squid_restarts=$(( squid_restarts + 1 ))
    log "egress proxy process gone — restarting squid (restart #$squid_restarts)..."
    squid -N >>/var/log/squid/boot.log 2>&1 &
    (( squid_restarts >= 5 )) && \
      log "⚠ squid restarted $squid_restarts times — likely a config error; see /var/log/squid/boot.log"
  fi
  sleep 30
done
