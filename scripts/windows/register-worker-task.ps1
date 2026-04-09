param(
    [string]$TaskName = "RemoteWorkerAgent",
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
    [string]$UserName = "$env:USERDOMAIN\$env:USERNAME"
)

$startScript = Join-Path $RepoPath "scripts\windows\start-worker.cmd"
if (-not (Test-Path $startScript)) {
    throw "Missing start script: $startScript"
}

$credential = Get-Credential -UserName $UserName -Message "Enter the Windows password for the worker task"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$startScript`"" -WorkingDirectory $RepoPath
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $credential.UserName -LogonType Password -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -User $credential.UserName `
    -Password ($credential.GetNetworkCredential().Password) `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $($credential.UserName)."
Write-Host "Run: Start-ScheduledTask -TaskName `"$TaskName`""
