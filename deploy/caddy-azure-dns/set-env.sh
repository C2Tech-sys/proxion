#!/usr/bin/env bash
# Set (or replace) one variable in proxion.env from a silent prompt, then rebuild.
#
# For secrets you'd rather not type into a nested ssh/PowerShell quoting puzzle:
#
#     ssh -t <host> bash ~/proxion/deploy/caddy-azure-dns/set-env.sh PROXION_AGENT_TOKEN
#
# Prompts for the value (no echo), rewrites the line in proxion.env (or appends it),
# and runs `deploy.sh update` unless --no-update is given. Never prints the value.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

ENV_FILE=proxion.env
UPDATE=yes
KEY=""
for arg in "$@"; do
  case "$arg" in
    --no-update) UPDATE=no ;;
    -h|--help)
      echo "Usage: set-env.sh [--no-update] KEY"
      exit 0
      ;;
    *) KEY="$arg" ;;
  esac
done

if [ -z "$KEY" ] || ! [[ "$KEY" =~ ^[A-Z][A-Z0-9_]*$ ]]; then
  echo "set-env.sh: give one variable name (A-Z, 0-9, _), e.g. PROXION_AGENT_TOKEN" >&2
  exit 1
fi
if [ ! -f "$ENV_FILE" ]; then
  echo "set-env.sh: $ENV_FILE not found next to this script" >&2
  exit 1
fi

read -r -s -p "Value for ${KEY} (input hidden): " VALUE
echo
if [ -z "$VALUE" ]; then
  echo "set-env.sh: empty value, nothing changed" >&2
  exit 1
fi

# Rewrite via a temp file so the value never touches a shell command line or sed
# expression (no quoting or metacharacter problems, no traces in history).
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
FOUND=no
while IFS= read -r line || [ -n "$line" ]; do
  if [[ "$line" == "${KEY}="* ]]; then
    printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"
    FOUND=yes
  else
    printf '%s\n' "$line" >> "$TMP"
  fi
done < "$ENV_FILE"
if [ "$FOUND" = no ]; then
  printf '%s=%s\n' "$KEY" "$VALUE" >> "$TMP"
fi
chmod 600 "$TMP"
mv "$TMP" "$ENV_FILE"
trap - EXIT
echo "${KEY} set in ${ENV_FILE} (${#VALUE} characters)."

if [ "$UPDATE" = yes ]; then
  bash ./deploy.sh update
fi
