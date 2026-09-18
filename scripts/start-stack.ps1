$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $workspaceRoot 'infra/docker-compose.yml'
$envFile = Join-Path $workspaceRoot 'infra/.env.example'

docker compose --env-file $envFile -f $composeFile run --rm migrator
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

docker compose --env-file $envFile -f $composeFile up -d --build --wait --wait-timeout 300
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node (Join-Path $PSScriptRoot 'check-stack.mjs')
exit $LASTEXITCODE
