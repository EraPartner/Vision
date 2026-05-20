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
SENTINEL="/run/vision-firewall-ok"
# Forwarded host ports (Docker DNAT delivers these to the container).
INBOUND_PORTS=(8080 3002)

# Stale sentinel must never outlive a re-apply: clear it up front so a partial
# failure below can't leave a "verified" marker from a previous run.
rm -f "$SENTINEL" 2>/dev/null || true

# --- FAIL-CLOSED FIRST ---
# Set default-deny BEFORE flushing/adding anything. set -e is intentionally off
# (best-effort apply), so if any rule below fails mid-way the netns is already
# closed and stays closed — never silently fail-open.
iptables  -P INPUT   DROP
iptables  -P OUTPUT  DROP
iptables  -P FORWARD DROP
ip6tables -P INPUT   DROP
ip6tables -P OUTPUT  DROP
ip6tables -P FORWARD DROP

# --- Reset rules (policies set above stay DROP across a flush) ---
iptables -F
iptables -F VISION_DENY 2>/dev/null || true
iptables -X VISION_DENY 2>/dev/null || true
iptables -X 2>/dev/null || true
# NOTE: we deliberately do NOT flush the NAT table. We add no NAT rules of our
# own, and on plain Docker/bridge networking the embedded DNS (127.0.0.11) is
# NAT-based — flushing it would break name resolution. Leaving NAT untouched
# keeps this portable beyond Docker Desktop.
ip6tables -F
ip6tables -X 2>/dev/null || true

# --- IPv6: loopback only (everything else stays default-DROP) ---
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

# --- Verify the lock actually took, then drop the sentinel ---
if iptables -S OUTPUT 2>/dev/null | grep -q '^-P OUTPUT DROP' \
   && iptables -C OUTPUT -m owner --uid-owner "$PROXY_USER" -j ACCEPT 2>/dev/null; then
  : > "$SENTINEL" 2>/dev/null || true
  echo "[firewall] Egress locked to proxy UID '$PROXY_USER' (IPv4 + IPv6 default-deny, verified)."
else
  rm -f "$SENTINEL" 2>/dev/null || true
  echo "[firewall] ERROR: egress-lock verification FAILED — egress stays default-DROP (fail-closed)." >&2
  exit 1
fi
