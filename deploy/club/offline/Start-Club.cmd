@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem SPDX-FileCopyrightText: 2026 Hexproof contributors
setlocal
pushd "%~dp0" || exit /b 1
if not defined CLUB_PORT set "CLUB_PORT=57325"
if not defined CLUB_STATE_DIR set "CLUB_STATE_DIR=%CD%\state"
set "CLUB_OPEN=-club-open-browser"
if "%CLUB_NO_BROWSER%"=="1" set "CLUB_OPEN="
echo Starting Offline Club. Keep this window open. Press Ctrl+C to stop.
"%CD%\hexproof-server.exe" -club-offline %CLUB_OPEN% -bind 127.0.0.1 -port "%CLUB_PORT%" ^
  -club-web-root "%CD%\web" -forge-java "%CD%\jre\bin\java.exe" -forge-home "%CD%\hexproof-forge-runtime\forge-gui" ^
  -forge-harness "%CD%\hexproof-forge-runtime\forge-harness.jar" -forge-overlay "%CD%\forge-overlay.jar" ^
  -forge-start-timeout 4m -max-forge-games 1 -retention-dir "%CLUB_STATE_DIR%\retained"
set "CLUB_EXIT=%ERRORLEVEL%"
popd
if not "%CLUB_EXIT%"=="0" pause
exit /b %CLUB_EXIT%
