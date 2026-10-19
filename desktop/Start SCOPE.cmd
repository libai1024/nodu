@echo off
rem SPDX-License-Identifier: MIT
setlocal DisableDelayedExpansion
set "SCOPE_ROOT=%~dp0"
if exist "%SCOPE_ROOT%.tools\node_modules\node\bin\node.exe" set "PATH=%SCOPE_ROOT%.tools\node_modules\node\bin;%PATH%"
set "SCOPE_NODE_MAJOR="
for /f "delims=" %%V in ('node -p "process.versions.node.split('.')[0]" 2^>nul') do set "SCOPE_NODE_MAJOR=%%V"
if not "%SCOPE_NODE_MAJOR%"=="24" (
    echo SCOPE requires Node.js 24. Install or activate Node 24, then run this launcher again.
    exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found. Install Node.js 24 with npm before starting SCOPE.
    exit /b 1
)
cd /d "%SCOPE_ROOT%"
call npm run start:electron -- %*
exit /b %ERRORLEVEL%
