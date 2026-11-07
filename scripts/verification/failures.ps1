param([switch]$Remaining, [switch]$DatabaseOnly, [switch]$IdentityOnly)
$ErrorActionPreference = 'Stop'
function Run-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Docker verification failed: $($args -join ' ')" } }
function Check { param([string]$Phase) Run-Docker compose --profile tools run --rm --volume ./scripts/verification:/workspace/scripts/verification:ro submission-checks outages $Phase }
if (docker ps -aq --filter name=^tops-outage-commerce$) { throw 'Inspect the existing outage replica before another run' }
try {
    if (-not $IdentityOnly) {
        if (-not $Remaining -and -not $DatabaseOnly) {
            Check stock-race
            Run-Docker compose --profile tools run --rm --build fulfillment-checks prepare-broker
            Run-Docker compose stop rabbitmq
            Run-Docker compose --profile tools run --rm fulfillment-checks run-broker
            Run-Docker compose restart commerce billing
            Run-Docker compose up --detach --no-deps --wait --wait-timeout 120 rabbitmq
            Run-Docker compose --profile tools run --rm fulfillment-checks recover-broker
            Run-Docker compose --profile tools run --rm fulfillment-checks prepare-bank
            Run-Docker compose stop bank-simulator
            Run-Docker compose --profile tools run --rm fulfillment-checks run-bank
            Run-Docker compose restart commerce billing
            Start-Sleep -Seconds 45
            Check bank-evidence
            Run-Docker compose up --detach --no-deps --wait --wait-timeout 120 bank-simulator
            Run-Docker compose --profile tools run --rm fulfillment-checks recover-bank
        }
        if (-not $DatabaseOnly) {
            Check prepare-identity
            Run-Docker compose stop redis
            Run-Docker compose run --detach --no-deps --name tops-outage-commerce commerce
            Run-Docker compose --profile tools run --rm --build recovery-checks redis-down
            Run-Docker rm -f tops-outage-commerce
            Run-Docker compose up --detach --no-deps --wait redis
        }
        Check prepare-db
        Run-Docker compose stop postgres
        Check db-down
        Run-Docker compose up --detach --no-deps --wait --wait-timeout 120 postgres
        Run-Docker compose restart commerce billing bank-simulator identity storage-monitor
        Run-Docker compose up --detach --wait --wait-timeout 240
        Check recover-db
    }
    Check prepare-identity
    Run-Docker compose stop identity
    Check identity-warm
    Run-Docker compose restart gateway
    Check identity-cold
    Run-Docker compose up --detach --no-deps --wait --wait-timeout 240 identity
    Check recover-identity
} finally {
    $temporaryReplica = docker ps -aq --filter name=^tops-outage-commerce$
    if ($temporaryReplica) { docker rm -f tops-outage-commerce }
    Run-Docker compose up --detach --wait --wait-timeout 300
}
