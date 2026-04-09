@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"

cd /d "%REPO_ROOT%"

if not exist logs mkdir logs

echo [%DATE% %TIME%] starting remote-worker-agent>> logs\worker.log
call npm run start >> logs\worker.log 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%DATE% %TIME%] remote-worker-agent exited with code %EXIT_CODE%>> logs\worker.log

exit /b %EXIT_CODE%
