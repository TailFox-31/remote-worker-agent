param(
    [string]$TaskName = "RemoteWorkerAgent",
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$UserName = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$InteractiveOnly
)

$ErrorActionPreference = "Stop"

$startScript = Join-Path $RepoPath "scripts\windows\start-worker.cmd"
if (-not (Test-Path $startScript)) {
    throw "Missing start script: $startScript"
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$startScript`"" -WorkingDirectory $RepoPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)

if ($InteractiveOnly) {
    $principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Highest

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Force | Out-Null

    Write-Host "Registered scheduled task '$TaskName' for $UserName (interactive-only mode)."
    Write-Host "This mode runs only while that user is logged on."
    Write-Host "Run: Start-ScheduledTask -TaskName `"$TaskName`""
    return
}

$credential = Get-Credential -UserName $UserName -Message "Enter the Windows account password for the worker task"
$password = $credential.GetNetworkCredential().Password

if ([string]::IsNullOrWhiteSpace($password)) {
    throw @"
Task Scheduler requires the actual Windows account password.
Windows Hello PIN is not accepted here.

If you do not have a password-configured account, either:
  1. rerun this script with the real account password
  2. use -InteractiveOnly as a fallback (runs only while logged on)
"@
}

$principal = New-ScheduledTaskPrincipal -UserId $credential.UserName -LogonType Password -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -User $credential.UserName `
    -Password $password `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $($credential.UserName)."
Write-Host "Run: Start-ScheduledTask -TaskName `"$TaskName`""
