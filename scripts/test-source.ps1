$ErrorActionPreference = 'Stop'

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $workspaceRoot 'infra/docker-compose.yml'
$envFile = Join-Path $workspaceRoot 'infra/.env.verify.example'
$backendPath = Join-Path $workspaceRoot 'kill-it-twice-backend'
$projectName = 'kill-it-twice-source-test'
$previousTestDatabaseUrl = $env:TEST_DATABASE_URL
$testExitCode = 1

try {
  docker compose --project-name $projectName --env-file $envFile -f $composeFile up -d postgres --wait --wait-timeout 120
  if ($LASTEXITCODE -ne 0) { throw 'Failed to start the isolated test database' }

  docker compose --project-name $projectName --env-file $envFile -f $composeFile run --rm migrator
  if ($LASTEXITCODE -ne 0) { throw 'Failed to migrate the isolated test database' }

  $env:TEST_DATABASE_URL = 'postgresql://optio:optio-verify@127.0.0.1:25432/optio_verify'
  Push-Location $backendPath
  try {
    npm run test:integration
    $testExitCode = $LASTEXITCODE
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $previousTestDatabaseUrl) {
    Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue
  } else {
    $env:TEST_DATABASE_URL = $previousTestDatabaseUrl
  }

  docker compose --project-name $projectName --env-file $envFile -f $composeFile down --volumes --remove-orphans
}

exit $testExitCode
