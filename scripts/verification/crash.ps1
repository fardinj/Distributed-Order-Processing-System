param(
    [ValidateSet('DIGITAL','SUBSCRIPTION','PHYSICAL')][string[]]$Types=@('DIGITAL','SUBSCRIPTION','PHYSICAL'),
    [ValidateSet('after_effect','after_commit')][string[]]$Phases=@('after_effect','after_commit')
)
$ErrorActionPreference = 'Stop'
function Run-Docker { & docker @args; if ($LASTEXITCODE -ne 0) { throw "Crash verification failed: $($args -join ' ')" } }
function Check { Run-Docker compose --profile tools run --rm --volume ./scripts/verification:/workspace/scripts/verification:ro submission-checks crash @args }
if (docker ps -aq --filter name=^tops-crash-commerce$) { throw 'Inspect the existing crash replica before running again' }
Run-Docker compose build commerce
$prepared=$false
try {
    foreach ($type in $Types) {
        foreach ($phase in $Phases) {
            Check prepare $phase $type
            $prepared=$true
            Run-Docker compose stop commerce
            Run-Docker compose run --detach --no-deps --name tops-crash-commerce --env TOPS_VERIFICATION_BARRIERS=1 --env VERIFICATION_CONTROL_FILE=/verification/control.json --volume ./.local/verification/crash-control:/verification commerce
            Run-Docker update --restart=no tops-crash-commerce
            Check release
            $deadline=[DateTime]::UtcNow.AddSeconds(45)
            while (-not (Test-Path -LiteralPath .local/verification/crash-control/barrier-reached.json)) {
                if ([DateTime]::UtcNow -gt $deadline) { throw 'Worker did not reach its deterministic barrier' }
                Start-Sleep -Milliseconds 100
            }
            # Kill immediately: the before-commit barrier is inside a bounded transaction.
            Run-Docker kill --signal KILL tops-crash-commerce
            $state=docker inspect --format '{{.State.ExitCode}} {{.State.Running}}' tops-crash-commerce
            if ($state -ne '137 false') { throw "Expected actual SIGKILL exit, observed $state" }
            Check killed
            Run-Docker rm tops-crash-commerce
            Run-Docker compose up --detach --no-deps --wait --wait-timeout 120 commerce
            Check recover
            $prepared=$false
        }
    }
} finally {
    $replica=docker ps -aq --filter name=^tops-crash-commerce$
    if ($replica) { docker rm -f tops-crash-commerce }
    Run-Docker compose up --detach --no-deps --wait --wait-timeout 120 commerce
    if ($prepared) { Check release; Check recover }
}
