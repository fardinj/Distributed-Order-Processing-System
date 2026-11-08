$ErrorActionPreference = 'Stop'
function Run-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Docker durability step failed: $($args -join ' ')" } }
$original = docker compose config --format json | ConvertFrom-Json
$sourceProject = $original.name
$sourcePublic = $original.services.gateway.environment.PUBLIC_URL
$sourcePort = $original.services.gateway.ports[0].published
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$workspace = (Get-Location).Path
$proofDirectory = Join-Path $workspace ".local/verification/$runId"
if (Test-Path -LiteralPath $proofDirectory) { throw 'A fresh proof directory is required' }
New-Item -ItemType Directory -Path $proofDirectory | Out-Null
$setupRoot = Join-Path $proofDirectory 'clean-setup'
New-Item -ItemType Directory -Path (Join-Path $setupRoot 'scripts') | Out-Null
Copy-Item -LiteralPath scripts/setup.mjs -Destination (Join-Path $setupRoot 'scripts/setup.mjs')
Copy-Item -LiteralPath .env.example -Destination (Join-Path $setupRoot '.env.example')
function Source-Environment {
 $env:COMPOSE_PROJECT_NAME=$sourceProject; $env:PUBLIC_URL=$sourcePublic; $env:GATEWAY_PORT=$sourcePort
}
function Target-Environment { param([string]$Project,[string]$Credentials,[string]$State)
 $env:COMPOSE_PROJECT_NAME=$Project; $env:PUBLIC_URL='http://localhost:18080'; $env:GATEWAY_PORT='18080'; $env:VERIFY_CREDENTIAL_ROOT=$Credentials; $env:VERIFY_IDENTITY_STATE=$State
 New-Item -ItemType Directory -Force -Path $State | Out-Null
}
function Source-Check { Run-Docker compose --profile tools run --rm --volume ./scripts/verification:/workspace/scripts/verification:ro submission-checks @args }
function Target-Docker { Run-Docker compose -f compose.yaml -f compose.verify.yaml @args }
function Target-Check { Target-Docker --profile tools run --rm --volume ./scripts/verification:/workspace/scripts/verification:ro submission-checks @args }
$cleanProject="tops-clean-$runId".ToLower(); $restoreProject="tops-restore-$runId".ToLower()
$env:BACKUP_RUN=$runId
$sourcePaused=$false; $currentTarget=$null
try {
 Source-Environment
 Run-Docker compose --profile bootstrap build seed migrate
 Source-Check outages prepare-restore
 Source-Check outages admission-pause
 $sourcePaused=$true
 Run-Docker compose stop gateway commerce billing bank-simulator identity storage-monitor rabbitmq redis
 Source-Check snapshot
 Run-Docker compose --profile operations run --rm backup dump
 Run-Docker compose stop postgres
 # Fresh-install proof uses newly generated credentials as well as fresh data volumes.
 Run-Docker run --rm --network none --mount "type=bind,source=$setupRoot,target=/workspace" -w /workspace node:24.15.0-bookworm-slim node scripts/setup.mjs
 Run-Docker run --rm --network none --mount "type=bind,source=$setupRoot,target=/workspace" -w /workspace node:24.15.0-bookworm-slim node scripts/setup.mjs
 $cleanCredentials=".local/verification/$runId/clean-setup/.local"; $cleanState=".local/verification/$runId/clean-identity"
 Target-Environment $cleanProject $cleanCredentials $cleanState; $currentTarget=$cleanProject
 Target-Docker up --detach --wait --wait-timeout 240 postgres rabbitmq redis identity
 Target-Docker --profile bootstrap run --rm migrate
 Target-Docker --profile bootstrap run --rm identity-init --fixtures
 Target-Docker --profile bootstrap run --rm seed
 Target-Docker up --detach --no-build --wait --wait-timeout 240
 Target-Docker --profile tools run --rm tools node scripts/smoke.mjs
 Target-Check outages clean-smoke
 Target-Docker stop
 $currentTarget=$null
 $restoreState=".local/verification/$runId/restore-identity"
 Target-Environment $restoreProject '.local' $restoreState; $currentTarget=$restoreProject
 Target-Docker up --detach --wait --wait-timeout 120 postgres
 Target-Check restore guard
 Target-Docker --profile operations run --rm backup restore
 Target-Check restore compare
 Target-Check restore replay-gaps
 Target-Docker up --detach --wait --wait-timeout 240 rabbitmq redis identity
 Target-Docker --profile bootstrap run --rm identity-init --fixtures
 Target-Docker up --detach --no-build --wait --wait-timeout 240
 Target-Check outages resume-restore
 Target-Docker --profile tools run --rm tools node scripts/smoke.mjs
 @{run=$runId;cleanProject=$cleanProject;restoreProject=$restoreProject;sourceProject=$sourceProject;completedAt=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -Encoding utf8 .local/verification/durability-results.json
 Write-Output 'PASS fresh install and isolated four-owner restore completed; source/target volumes retained'
} finally {
 if ($currentTarget) { docker compose -f compose.yaml -f compose.verify.yaml stop }
 Source-Environment
 Run-Docker compose up --detach --wait --wait-timeout 300
 if ($sourcePaused) {
   Source-Check outages resume-restore
   Source-Check outages admission-resume
 }
}
