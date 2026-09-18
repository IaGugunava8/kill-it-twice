#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
compose_file="$workspace_root/infra/docker-compose.yml"
env_file="$workspace_root/infra/.env.verify.example"
project_name="kill-it-twice-source-test"

cleanup() {
  docker compose \
    --project-name "$project_name" \
    --env-file "$env_file" \
    -f "$compose_file" \
    down --volumes --remove-orphans
}
trap cleanup EXIT

docker compose \
  --project-name "$project_name" \
  --env-file "$env_file" \
  -f "$compose_file" \
  up -d postgres --wait --wait-timeout 120

docker compose \
  --project-name "$project_name" \
  --env-file "$env_file" \
  -f "$compose_file" \
  run --rm migrator

cd "$workspace_root/kill-it-twice-backend"
TEST_DATABASE_URL='postgresql://optio:optio-verify@127.0.0.1:25432/optio_verify' \
  npm run test:integration
