#!/usr/bin/env bash
# Vision devcontainer egress firewall — proxy-only model.
#
# Baked into the image at /usr/local/sbin/vision-firewall; invoked by the root
# entrypoint on every container start. The repo copy at
# .devcontainer/init-firewall.sh is the source — edits require a rebuild.
#
# Egress is locked to the squid proxy's UID only. Everything else (dev
# sessions, npm/bun postinstalls, …) must go through the proxy on
# 127.0.0.1:3128, where squid enforces the hostname allowlist (see squid.conf).
# A process that ignores HTTPS_PROXY and connects directly is dropped here,
# because its socket UID is not `proxy`.
#
# Replaces the older IP-allowlist/ipset approach: hostname enforcement now
# lives in the proxy (no DNS-resolution dance, no stale-IP problem).

set -uo pipefail

PROXY_USER="proxy"
# Forwarded host ports (Docker DNAT delivers these to the container).
INBOUND_PORTS=(8080 3002)

# --- IPv4 reset ---
iptables -F
iptables -F VISION_DENY 2>/dev/null || true
iptables -X VISION_DENY 2>/dev/null || true
iptables -X 2>/dev/null || true
iptables -t nat -F
iptables -t nat -X 2>/dev/null || true

# --- IPv6: default-deny everything except loopback ---
ip6tables -F
ip6tables -X 2>/dev/null || true
ip6tables -P INPUT   DROP
ip6tables -P FORWARD DROP
ip6tables -P OUTPUT  DROP
ip6tables -A INPUT  -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT

# --- IPv4 base allows ---
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Only the proxy UID may originate outbound traffic (DNS, 80, 443, …).
iptables -A OUTPUT -m owner --uid-owner "$PROXY_USER" -j ACCEPT

# Inbound on forwarded ports (host browser → frontend/backend).
for p in "${INBOUND_PORTS[@]}"; do
  iptables -A INPUT -p tcp --dport "$p" -j ACCEPT
done

# Logged-DROP for everything else, rate-limited. `dmesg | grep vision-deny`.
iptables -N VISION_DENY
iptables -A VISION_DENY -m limit --limit 10/min -j LOG --log-prefix "vision-deny: " --log-level 4
iptables -A VISION_DENY -j DROP
iptables -A OUTPUT -j VISION_DENY

# Default policies — deny what isn't explicitly allowed above.
iptables -P INPUT   DROP
iptables -P FORWARD DROP
iptables -P OUTPUT  DROP

echo "[firewall] Egress locked to proxy UID '$PROXY_USER' (IPv4 + IPv6 default-deny)."
