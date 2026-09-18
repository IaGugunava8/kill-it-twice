#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
workspace_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

docker compose \
  --env-file "$workspace_root/infra/.env.example" \
  -f "$workspace_root/infra/docker-compose.yml" \
  run --rm migrator

docker compose \
  --env-file "$workspace_root/infra/.env.example" \
  -f "$workspace_root/infra/docker-compose.yml" \
  up -d --build --wait --wait-timeout 300

node "$script_dir/check-stack.mjs"
