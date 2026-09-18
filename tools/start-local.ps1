#requires -Version 5.1
<#
.SYNOPSIS
Starts the local Windows development database, server and client.
.DESCRIPTION
Requires installed dependencies, converted assets, local settings and migrated SQL.
Reuses responsive game services. Logs and process IDs stay in ignored artifacts/local.
For custom service settings, pass matching URLs. This does not change .env files.
.EXAMPLE
.\tools\start-local.ps1 -NoBrowser
#>
[CmdletBinding()]
param(
    [switch]$NoBrowser,
    [uri]$ServerUrl = 'http://127.0.0.1:3200',
    [uri]$ClientUrl = 'http://127.0.0.1:3102',
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runRoot = Join-Path $projectRoot 'artifacts\local'

function Assert-LocalOrigin([uri]$Url) {
    if (-not $Url.IsAbsoluteUri -or $Url.Scheme -ne 'http' -or -not $Url.IsLoopback -or
        $Url.AbsolutePath -ne '/' -or $Url.Query -or $Url.Fragment -or $Url.UserInfo) {
        throw 'Service URLs must be exact loopback HTTP origins, such as http://127.0.0.1:3102.'
    }
}

function Find-Executable([string]$Name, [string]$Fallback = '') {
    $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    if ($Fallback -and (Test-Path -LiteralPath $Fallback -PathType Leaf)) { return $Fallback }
    throw "$Name was not found. Install the prerequisites in docs/windows-setup.md and reopen PowerShell."
}

function Get-GameConfiguration([uri]$Url) {
    try {
        $configuration = Invoke-RestMethod -Uri "$($Url.AbsoluteUri)api/v1/config" -Headers @{ Origin = $ClientUrl.GetLeftPart('Authority') } -TimeoutSec 2
    } catch {
        # Connection/HTTP/decoding failures mean the service is not ready yet.
        Write-Verbose "Readiness check for $Url failed: $($_.Exception.Message)"
        return $null
    }
    if ($configuration.v -eq 1 -and $configuration.assetBuildId -and $configuration.rulesHash) {
        return $configuration
    }
    return $null
}

function Invoke-Docker([string[]]$Arguments, [int]$Timeout) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $runRoot "docker-$stamp.log"
    $stderr = Join-Path $runRoot "docker-$stamp-error.log"
    $commandProcess = Start-Process -FilePath $dockerPath -ArgumentList $Arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    # Retain the handle so Windows PowerShell can read ExitCode after a fast exit.
    $null = $commandProcess.Handle
    if (-not $commandProcess.WaitForExit($Timeout * 1000)) {
        $commandProcess.Kill()
        throw "Docker command timed out after $Timeout seconds. See $stdout and $stderr."
    }
    # Flush redirected output before displaying diagnostics, including failed commands.
    $commandProcess.WaitForExit()
    Get-Content -LiteralPath $stdout | Out-Host
    Get-Content -LiteralPath $stderr | Out-Host
    return $commandProcess.ExitCode
}

function Start-GameService([string]$Name, [string]$EntryPoint, [uri]$Url) {
    $configuration = Get-GameConfiguration $Url
    if ($configuration) {
        Write-Host "$Name is already ready at $Url"
        return $configuration
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $stdout = Join-Path $runRoot "$Name-$stamp.log"
    $stderr = Join-Path $runRoot "$Name-$stamp-error.log"
    $serviceProcess = Start-Process -FilePath $bunPath -ArgumentList $EntryPoint -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Set-Content -LiteralPath (Join-Path $runRoot "$Name.pid") -Value $serviceProcess.Id
    Write-Host "Starting $Name. Logs: $stdout and $stderr"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $serviceProcess.Refresh()
        if ($serviceProcess.HasExited) {
            Get-Content -LiteralPath $stderr -Tail 25 | Out-Host
            throw "$Name exited before it was ready. See $stdout and $stderr."
        }
        $configuration = Get-GameConfiguration $Url
        if ($configuration) {
            Write-Host "$Name is ready at $Url"
            return $configuration
        }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "$Name did not become ready within $TimeoutSeconds seconds. Its process may still be starting. Check $stdout and $stderr before retrying."
}

Assert-LocalOrigin $ServerUrl
Assert-LocalOrigin $ClientUrl
$bunPath = Find-Executable 'bun.exe' (Join-Path $env:USERPROFILE '.bun\bin\bun.exe')
$dockerPath = Find-Executable 'docker.exe' (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe')
foreach ($required in @('node_modules', '.env.server', '.env.client', 'client/public/generated/catalog.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $required))) {
        throw "Missing $required. Complete the first-time setup in docs/windows-setup.md. Assets are not converted during startup."
    }
}
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
Push-Location -LiteralPath $projectRoot
try {
    # Check the engine first; an open Desktop window does not establish readiness.
    if ((Invoke-Docker -Arguments @('info', '--format', '{{.ServerVersion}}') -Timeout 15) -ne 0) {
        if ((Invoke-Docker -Arguments @('desktop', 'start', '--timeout', '60') -Timeout 75) -ne 0) {
            throw 'Docker Desktop could not start. See docs/windows-setup.md#docker-startup-failures. No Docker files or volumes were changed by this launcher.'
        }
    }
    $composeExit = Invoke-Docker -Arguments @('compose', '-f', 'infra/compose.yaml', 'up', '-d', '--build', '--wait', '--wait-timeout', '90') -Timeout 600
    if ($composeExit -ne 0) { throw 'PostgreSQL did not become healthy. Inspect docker compose -f infra/compose.yaml logs postgres.' }
    $server = Start-GameService 'server' 'server/tools/dev.js' $ServerUrl
    $client = Start-GameService 'client' 'client/tools/dev-online.js' $ClientUrl
    if ($server.assetBuildId -ne $client.assetBuildId -or $server.rulesHash -ne $client.rulesHash) {
        throw 'Server and client reported different content identities. Check the configured upstream and running services.'
    }
    Write-Host "Open $ClientUrl. Default development login: player / password, unless OPENMS_DEV_PASSWORD is configured."
    if (-not $NoBrowser) { Start-Process $ClientUrl.AbsoluteUri }
} finally {
    Pop-Location
}
