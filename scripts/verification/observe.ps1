$ErrorActionPreference = 'Stop'
$observationRoot = Join-Path (Get-Location) '.local/verification'
New-Item -ItemType Directory -Force -Path $observationRoot | Out-Null
$serverContainers = @(docker compose ps -q) + @('tops-load-gateway')
docker inspect --format '{{.Name}} memory={{.HostConfig.Memory}} nanoCpus={{.HostConfig.NanoCpus}} image={{.Image}}' $serverContainers | Set-Content -Encoding utf8 (Join-Path $observationRoot 'load-limits.txt')
$sampleCount = 0
while ((docker inspect --format '{{.State.Running}}' tops-submission-load) -eq 'true') {
    $sampleCount++
    $sampleTime = [DateTime]::UtcNow.ToString('o')
    $containerSamples = @(docker stats --no-stream --format '{{json .}}' $serverContainers | ForEach-Object { $_ | ConvertFrom-Json })
    @{ at = $sampleTime; containers = $containerSamples } | ConvertTo-Json -Depth 5 -Compress | Add-Content -Encoding utf8 (Join-Path $observationRoot 'load-resources.jsonl')
    Write-Output "Resource sample $sampleCount recorded"
    Start-Sleep -Seconds 3
}
$ErrorActionPreference = 'Continue'
docker logs tops-submission-load 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -Encoding utf8 (Join-Path $observationRoot 'load-console.txt')
$ErrorActionPreference = 'Stop'
$loadExit = docker inspect --format '{{.State.ExitCode}}' tops-submission-load
Write-Output "Load exit code: $loadExit"
if ($loadExit -ne '0') { throw 'Load verification did not complete successfully; preserve the log and accepted work.' }
