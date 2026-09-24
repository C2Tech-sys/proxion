#!/usr/bin/env bash
# Reverses install.sh. Keeps /etc/proxion-agent/token by default so a
# reinstall doesn't require re-registering a new token with Proxion; pass
# --purge to remove the whole config directory (including the token).
#
# Usage: sudo ./uninstall.sh [--purge]
set -euo pipefail

BIN_DST=/usr/local/bin/proxion-agent
UNIT_DST=/etc/systemd/system/proxion-agent.service
CONF_DIR=/etc/proxion-agent

PURGE="no"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge)
      PURGE="yes"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--purge]"
      exit 0
      ;;
    *)
      echo "proxion-agent uninstall: unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "proxion-agent uninstall: must be run as root (try: sudo $0)" >&2
  exit 1
fi

if systemctl is-active --quiet proxion-agent 2>/dev/null; then
  systemctl stop proxion-agent
fi
systemctl disable proxion-agent 2>/dev/null || true

rm -f "$UNIT_DST"
systemctl daemon-reload

rm -f "$BIN_DST"

if [ "$PURGE" = "yes" ]; then
  rm -rf "$CONF_DIR"
  echo "proxion-agent uninstalled, including ${CONF_DIR} (token removed)."
else
  if [ -d "$CONF_DIR" ]; then
    find "$CONF_DIR" -mindepth 1 -not -name token -delete
  fi
  echo "proxion-agent uninstalled. Kept ${CONF_DIR}/token (pass --purge to remove it too)."
fi

rm -rf /run/proxion-agent 2>/dev/null || true
