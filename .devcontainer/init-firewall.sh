#!/usr/bin/env bash
# Vision devcontainer egress firewall.
#
# Adapted from anthropics/claude-code reference, trimmed to Vision's needs.
# Default-deny outbound; allowlists the domains used by:
#   - Bun / npm / GitHub for package install
#   - Anthropic API + claude.ai for Claude Code auth
#   - PostgreSQL APT (in case of rebuilds)
#   - Yahoo Finance (used by apps/node-backend yahoo-finance2)
#   - PyPI (alembic and friends)
#
# Localhost traffic is fully allowed so backend/frontend/postgres can talk
# to each other on 127.0.0.1.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  exec sudo --preserve-env=PATH bash "$0" "$@"
fi

ALLOWED_DOMAINS=(
  # Anthropic
  "api.anthropic.com"
  "console.anthropic.com"
  "claude.ai"
  "statsig.anthropic.com"
  "sentry.io"
  # Claude Code update / auth callbacks
  "code.claude.com"
  "docs.claude.com"
  # Bun
  "bun.sh"
  "registry.npmjs.org"
  # GitHub (source / releases / API)
  "github.com"
  "api.github.com"
  "objects.githubusercontent.com"
  "raw.githubusercontent.com"
  "codeload.github.com"
  "ghcr.io"
  "pkg-containers.githubusercontent.com"
  # PyPI for alembic
  "pypi.org"
  "files.pythonhosted.org"
  # Debian / PG apt mirrors
  "deb.debian.org"
  "security.debian.org"
  "apt.postgresql.org"
  # Vision runtime external calls
  "query1.finance.yahoo.com"
  "query2.finance.yahoo.com"
  "finance.yahoo.com"
  # VS Code marketplace (for extensions)
  "marketplace.visualstudio.com"
  "update.code.visualstudio.com"
)

# --- Reset existing rules ---
iptables -F
iptables -X
iptables -t nat -F
iptables -t nat -X
ipset destroy vision-allowed 2>/dev/null || true

ipset create vision-allowed hash:net family inet

# Loopback always allowed (backend ↔ postgres ↔ frontend run here)
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Established / related — replies come back through
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# DNS — UDP/53 to the resolver only. (Anthropic's reference leaves DNS open;
# we restrict to the configured resolver to reduce DNS-tunneling surface.)
RESOLVER="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf || true)"
if [[ -n "${RESOLVER:-}" ]]; then
  iptables -A OUTPUT -p udp --dport 53 -d "$RESOLVER" -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -d "$RESOLVER" -j ACCEPT
fi

# Resolve each allowed domain to IPs and add them to the ipset.
for domain in "${ALLOWED_DOMAINS[@]}"; do
  while read -r ip; do
    [[ -n "$ip" ]] && ipset add vision-allowed "$ip" 2>/dev/null || true
  done < <(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u)
done

# Default policies — drop everything not explicitly allowed.
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

# Allow outbound to the resolved IPs.
iptables -A OUTPUT -m set --match-set vision-allowed dst -j ACCEPT

# Allow incoming traffic from host on forwarded ports (Docker bridge handles
# this via DNAT, but we keep an explicit accept for clarity).
iptables -A INPUT -p tcp --dport 8080 -j ACCEPT
iptables -A INPUT -p tcp --dport 3002 -j ACCEPT

echo "[firewall] Default-deny egress active. Allowed: ${#ALLOWED_DOMAINS[@]} domains."
