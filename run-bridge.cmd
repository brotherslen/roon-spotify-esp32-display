@echo off
rem Launcher for the Roon Now Playing bridge, used by the "RoonNowPlayingBridge" scheduled task.
rem The log is truncated once per task start so it can't grow without bound across logons.
rem If node exits (a crash), it is restarted after 5s instead of leaving the display on
rem "Bridge unreachable" until the next logon; restarts append to the same log.
cd /d "%~dp0"
type nul > "%~dp0bridge.log"
rem Stop-ScheduledTask ends only this cmd.exe. With EXIT_WITH_PARENT set, node notices within ~2s and
rem shuts down (Chromium included) instead of being orphaned, holding the port with the old code.
set EXIT_WITH_PARENT=1
:run
"C:\Program Files\nodejs\node.exe" server.js >> "%~dp0bridge.log" 2>&1
echo [%date% %time%] bridge exited with code %errorlevel%, restarting in 5s >> "%~dp0bridge.log"
rem ping as the delay: "timeout" fails without a console, which a scheduled task doesn't have.
ping -n 6 127.0.0.1 > nul
goto run
