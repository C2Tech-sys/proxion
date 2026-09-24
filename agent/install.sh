#!/usr/bin/env bash
# Installs / upgrades proxion-agent on a Proxmox VE node. Idempotent: safe to
# re-run to upgrade the binary or unit without disturbing the existing token.
#
# Usage: sudo ./install.sh [--bind <ip>] [--port <n>] [--allow-any-bind]
set -euo pipefail

BIN_SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DST=/usr/local/bin/proxion-agent
UNIT_SRC="${BIN_SRC_DIR}/proxion-agent.service"
UNIT_DST=/etc/systemd/system/proxion-agent.service
CONF_DIR=/etc/proxion-agent
ENV_FILE="${CONF_DIR}/agent.env"
TOKEN_FILE="${CONF_DIR}/token"

BIND=""
PORT="9420"
ALLOW_ANY_BIND="no"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --bind)
      BIND="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --allow-any-bind)
      ALLOW_ANY_BIND="yes"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--bind <ip>] [--port <n>] [--allow-any-bind]"
      exit 0
      ;;
    *)
      echo "proxion-agent install: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "proxion-agent install: must be run as root (try: sudo $0)" >&2
  exit 1
fi

if [ -z "$BIND" ]; then
  if [ -t 0 ]; then
    read -r -p "Bind address for proxion-agent (a private/mesh IP, e.g. a WireGuard/Tailscale address) [127.0.0.1]: " BIND
    BIND="${BIND:-127.0.0.1}"
  else
    BIND="127.0.0.1"
  fi
fi

if [ "$BIND" = "0.0.0.0" ] && [ "$ALLOW_ANY_BIND" != "yes" ]; then
  echo "proxion-agent install: refusing to bind 0.0.0.0 (all interfaces)." >&2
  echo "Bind to a private/mesh address instead, or pass --allow-any-bind if you really mean it." >&2
  exit 1
fi

echo "proxion-agent install: bind=${BIND} port=${PORT}"

install -m 0755 -o root -g root "${BIN_SRC_DIR}/proxion-agent.py" "$BIN_DST"
install -m 0644 -o root -g root "$UNIT_SRC" "$UNIT_DST"

umask 077
mkdir -p "$CONF_DIR"
chmod 0700 "$CONF_DIR"

cat > "$ENV_FILE" <<EOF
PROXION_AGENT_BIND=${BIND}
PROXION_AGENT_PORT=${PORT}
EOF
chmod 0600 "$ENV_FILE"

TOKEN_IS_NEW="no"
if [ ! -f "$TOKEN_FILE" ]; then
  python3 -c 'import secrets; print(secrets.token_hex(32))' > "$TOKEN_FILE"
  chmod 0600 "$TOKEN_FILE"
  TOKEN_IS_NEW="yes"
fi

systemctl daemon-reload
systemctl enable --now proxion-agent

echo
echo "proxion-agent installed and running on ${BIND}:${PORT}."
if [ "$TOKEN_IS_NEW" = "yes" ]; then
  echo
  echo "Generated a new bearer token (shown once now; it lives at ${TOKEN_FILE}):"
  echo
  echo "    $(cat "$TOKEN_FILE")"
  echo
  echo "Add this to Proxion as PROXION_AGENT_TOKEN."
else
  echo "Existing token at ${TOKEN_FILE} left unchanged."
fi
echo
echo "Verify with:"
echo "    curl -H \"Authorization: Bearer \$(cat ${TOKEN_FILE})\" http://${BIND}:${PORT}/health"
