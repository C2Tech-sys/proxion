#!/usr/bin/env bash
# Runs ON the target host, from this directory (deploy/caddy-azure-dns/).
#
# Usage: ./deploy.sh <up|logs|down|status|update|build>
#
#   up      Pull the proxion image, build the Caddy image, start the stack,
#           wait for proxion to report healthy, print the site URL.
#   logs    Follow logs for both services.
#   down    Stop and remove the stack (named volumes -- cert data -- kept).
#   status  Show container/service status.
#   update  Pull the proxion image named by PROXION_IMAGE (.env) and recreate
#           just that service (Caddy is left running, no cert re-issuance).
#           To upgrade, bump the tag in .env, then run this.
#   build   For a checkout-built proxion instead of the published image
#           (uncomment `build:` in docker-compose.yml first): build it from
#           the current tree and recreate the service.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

REQUIRED_ENV_FILES=(.env proxion.env caddy.env)

check_env_files() {
  local missing=()
  for f in "${REQUIRED_ENV_FILES[@]}"; do
    if [[ ! -f "$f" ]]; then
      missing+=("$f")
    fi
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing env file(s): ${missing[*]}" >&2
    echo "Copy the matching *.env.example file(s) and fill in real values first." >&2
    exit 1
  fi

  for f in "${REQUIRED_ENV_FILES[@]}"; do
    if grep -qE 'example\.com|CHANGEME' "$f"; then
      echo "$f still contains a placeholder (example.com or CHANGEME) -- fill in real values first." >&2
      exit 1
    fi
  done
}

compose() {
  docker compose --env-file .env "$@"
}

site_url() {
  # shellcheck disable=SC1091
  source .env
  printf 'https://%s\n' "${PROXION_HOST:-<PROXION_HOST unset>}"
}

wait_for_health() {
  local service="$1" tries=30
  echo "Waiting for '$service' to report healthy..."
  for (( i = 0; i < tries; i++ )); do
    local cid status
    cid="$(compose ps -q "$service")"
    if [[ -n "$cid" ]]; then
      status="$(docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || echo unknown)"
      if [[ "$status" == "healthy" ]]; then
        echo "'$service' is healthy."
        return 0
      fi
    fi
    sleep 2
  done
  echo "Timed out waiting for '$service' to become healthy. Check: ./deploy.sh logs" >&2
  return 1
}

cmd_up() {
  check_env_files
  compose pull --ignore-buildable
  compose build
  compose up -d
  wait_for_health proxion
  echo "Proxion should now be reachable at:"
  site_url
}

cmd_logs() {
  compose logs -f
}

cmd_down() {
  compose down
}

cmd_status() {
  compose ps
}

cmd_update() {
  check_env_files
  compose pull proxion
  compose up -d --no-deps proxion
  wait_for_health proxion
  echo "proxion updated and recreated (running $(compose ps -q proxion | xargs docker inspect --format '{{.Config.Image}}'))."
}

cmd_build() {
  check_env_files
  compose build proxion
  compose up -d --no-deps proxion
  wait_for_health proxion
  echo "proxion built from the current tree and recreated."
}

case "${1:-}" in
  up) cmd_up ;;
  logs) cmd_logs ;;
  down) cmd_down ;;
  status) cmd_status ;;
  update) cmd_update ;;
  build) cmd_build ;;
  *)
    echo "Usage: $0 <up|logs|down|status|update|build>" >&2
    exit 1
    ;;
esac
