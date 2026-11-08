$ErrorActionPreference = 'Stop'
function Run-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Load command failed: $($args -join ' ')" } }
foreach ($name in @('tops-load-gateway','tops-submission-load')) {
    if (docker ps -aq --filter "name=^$name`$") { throw "Existing verification container $name requires inspection before another run" }
}
$root = Join-Path (Get-Location) '.local/verification'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$archive = Join-Path $root ('load-history/' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $archive | Out-Null
foreach ($name in @('load-results.json','load-resources.jsonl','load-console.txt','load-limits.txt')) {
    $path = Join-Path $root $name
    if (Test-Path -LiteralPath $path) { Copy-Item -LiteralPath $path -Destination $archive }
}
try {
    Run-Docker compose --profile tools build submission-checks
    Run-Docker compose run --detach --no-deps --name tops-load-gateway gateway
    Run-Docker compose --profile tools run --detach --no-deps --name tops-submission-load --env LOAD_SECOND_ORIGIN=http://tops-load-gateway:3000 submission-checks load
    Set-Content -LiteralPath (Join-Path $root 'load-resources.jsonl') -Value ''
    & "$PSScriptRoot/observe.ps1"
} finally {
    # Only disposable test processes are removed. SQL-accepted work and all data volumes survive.
    $driver = docker ps -aq --filter name=^tops-submission-load$
    if ($driver) { docker rm -f tops-submission-load }
    $replica = docker ps -aq --filter name=^tops-load-gateway$
    if ($replica) { docker rm -f tops-load-gateway }
}
