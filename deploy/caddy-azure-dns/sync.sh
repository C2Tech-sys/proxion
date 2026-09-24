#!/usr/bin/env bash
# Runs on a DEVELOPER machine (a git checkout of the repo), not the target
# host. Packages the current git tree with `git archive HEAD` and streams
# it straight into place over ssh -- no rsync/scp, no intermediate file.
#
# Only files tracked by git go over the wire. `*.env` files are gitignored
# (see ../../.gitignore) and therefore untracked, so `git archive` never
# includes them -- real secrets never leave the host they were created on.
# Create proxion.env, caddy.env and .env by hand on the target host itself
# (copy the matching *.env.example and fill it in there), before running
# `./deploy.sh up`.
#
# Usage:
#   HOST=user@host DIR=/opt/proxion ./sync.sh
#
# HOST defaults to "CHANGEME" (must be overridden); DIR defaults to
# "~/proxion".
set -euo pipefail

HOST="${HOST:-CHANGEME}"
DIR="${DIR:-~/proxion}"

if [[ "$HOST" == "CHANGEME" ]]; then
  echo "Set HOST (e.g. HOST=user@100.64.0.2 DIR=/opt/proxion ./sync.sh)." >&2
  exit 1
fi

# Repo root (two levels up from this script's directory).
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "Syncing $(git rev-parse --short HEAD) from $REPO_ROOT to $HOST:$DIR ..."

ssh "$HOST" "mkdir -p '$DIR'"
git archive HEAD | ssh "$HOST" "tar -x -C '$DIR'"

echo "Done. On $HOST, cd into $DIR/deploy/caddy-azure-dns and create the"
echo "*.env files (see README.md) before running ./deploy.sh up."
