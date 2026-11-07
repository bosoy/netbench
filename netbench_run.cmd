@echo off
rem netbench runbook - three steps, all output into netbench.log next to this file
rem ASCII only: cmd reads the file in the oem codepage, cyrillic here would
rem turn comment lines into commands. the log is utf-8 with russian labels on
rem every box. on a modern console node's output is shown through powershell,
rem which hands the console unicode instead of raw bytes; on win7 / vista /
rem 2008 / 8.1 the console cannot draw utf-8, so there node prints english
rem labels and the russian text goes straight into the log. both the runtime
rem and that choice come from picknode.cmd, the same file the watch wrapper
rem uses, so one archive runs on every supported windows
rem usage: netbench_run.cmd [uplink_mbit] [a2s_ip:port] [cal_players] [cal_ai_cap]
rem   no uplink = measure the line; the upload test saturates it for ~8 seconds,
rem   players on a live server will lag during those seconds
rem   with an uplink number the speed test is skipped entirely: safe to run
rem   while people are playing, the server only answers the browser query
rem   no cal_players = step 3 is skipped
rem   an address in the first slot is understood too (it has a colon, a number
rem   does not), so the measurement run can still pass the server:
rem     netbench_run.cmd 127.0.0.1:2402 40 150
rem with measurement:    netbench_run.cmd
rem dry run:             netbench_run.cmd 200 127.0.0.1:2302 50 150
setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "OUT=%DIR%out"
set "LOG=%DIR%netbench.log"
set "TMPLOG=%TEMP%\netbench_step.txt"
set "TMPERR=%TEMP%\netbench_step_err.txt"
set "UPLINK=%~1"
set "A2S=%~2"
set "CALPLAYERS=%~3"
set "CALAICAP=%~4"

rem first argument with a colon = server address, not uplink: shift the list
rem left. without this "netbench_run.cmd 127.0.0.1:2402 40 150" reaches node as
rem --uplink 127.0.0.1:2402 and the whole fit matrix prints nan
echo %~1| findstr /c:":" >nul && (
	set "A2S=%~1"
	set "CALPLAYERS=%~2"
	set "CALAICAP=%~3"
	set "UPLINK="
)

if "%A2S%"=="" set "A2S=127.0.0.1:2302"
cd /d "%DIR%"

rem picknode.cmd decides two separate things for this windows: which bundled
rem runtime actually starts here, and whether this console can draw utf-8. it
rem leaves NODE and NETBENCH_SCREEN set
call "%DIR%picknode.cmd"
if errorlevel 1 (
	echo netbench: no working node on this box, see the message above>> "%LOG%"
	call :printlog
	exit /b 1
)

rem win7 / vista / 2008 / 8.1 consoles cannot draw utf-8: there node prints
rem english labels and tees the russian text straight into this log, so the
rem files stay russian on every box. the path goes through variables: a quoted
rem cli argument inside a batch variable is a quoting mess, an environment
rem variable is not.
rem NETBENCH_LEGACY=1 forces the english screen, =0 the powershell path, for
rem the rare box where the console and the version string disagree
set "LEGACY="
if "%NETBENCH_SCREEN%"=="legacy" set "LEGACY=1"
if "%NETBENCH_LEGACY%"=="1" set "LEGACY=1"
if "%NETBENCH_LEGACY%"=="0" set "LEGACY="
set "NETBENCH_LANG="
set "NETBENCH_TEE="
if defined LEGACY (
	set "NETBENCH_LANG=en"
	set "NETBENCH_TEE=%LOG%"
	echo console: old windows console detected, screen in english, log in russian
)

rem bare ip without a port: the retry below adds +1, so the port must be explicit
set "HASPORT="
for /f "tokens=2 delims=:" %%a in ("%A2S%") do set "HASPORT=%%a"
if not defined HASPORT set "A2S=%A2S%:2302"

rem bi numbers the steam query port as game+1, so the game port alone stays
rem silent by design and the model sat on the argument while the server was
rem answering two ports away. every step asks both, and 1b only runs when
rem neither of them answered
for /f "tokens=1,2 delims=:" %%a in ("%A2S%") do (
	set "HOST=%%a"
	set "PORT=%%b"
)
set /a PORT2=PORT+1
set "A2SFLAG=--a2s %HOST%:%PORT% --a2s %HOST%:%PORT2%"

rem empty uplink = do not pass the flag at all, then netbench measures the line
set "UPFLAG="
if not "%UPLINK%"=="" set "UPFLAG=--uplink %UPLINK%"

> "%LOG%" echo ============= netbench run =============
"%NODE%" -p "new Date().toISOString()" >> "%LOG%" 2>&1
"%NODE%" -v >> "%LOG%" 2>&1
if errorlevel 1 (
	echo netbench: the node picked above stopped working, install node or put node.exe next to this file>> "%LOG%"
	call :printlog
	exit /b 1
)

rem ---------------- 1. line + live server ----------------
rem a dead a2s port must not leave the model on the built-in 40: the 3rd
rem argument is his own slot count, so step 1 and 1b take it from there
set "PLAYERFLAG="
if not "%CALPLAYERS%"=="" set "PLAYERFLAG=--players %CALPLAYERS%"
call :say "args: uplink=%UPLINK% a2s=%A2S% cal_players=%CALPLAYERS% cal_ai_cap=%CALAICAP%"
call :say "---- 1. line + live server on %HOST%:%PORT% and %HOST%:%PORT2% ----"
if not defined UPFLAG (
	call :say "note: the upload test saturates the line for ~8 seconds"
) else (
	call :say "note: the line is not measured at all, your %UPLINK% Mbit/s is used"
)
"%NODE%" netbench.js %PLAYERFLAG% %UPFLAG% %A2SFLAG% --auto --out "%OUT%" > "%TMPLOG%" 2> "%TMPERR%"
call :show "%TMPLOG%" "%TMPERR%"

rem reuse the measured uplink in steps 1b and 3 so they do not print a fallback.
rem only a real measurement may be passed on: harvesting the fallback line would
rem relabel our own 100 Mbit/s assumption as if it were his tariff
if not defined UPFLAG (
	set "MEASURED="
	for /f "tokens=2 delims= " %%a in ('findstr /b /c:"uplink" "%TMPLOG%" ^| findstr /c:"measured upload"') do set "MEASURED=%%a"
	if not "!MEASURED!"=="" (
		set "UPFLAG=--uplink !MEASURED!"
		call :say "note: measured upload !MEASURED! Mbit/s reused in steps 1b and 3"
	) else (
		call :say "note: step 1 did not measure the upload, so the line below is the built-in assumption, not your tariff"
	)
)

rem neither port answered in step 1: ask once more with the line unloaded, the
rem upload test just saturated it and a udp timeout there is not proof of a
rem silent server
set "A2SOK="
findstr /c:"players, map" "%TMPLOG%" >nul && set "A2SOK=1"
if not defined A2SOK (
	set "NETFLAG="
	if defined UPFLAG (
		set "NETFLAG=--no-net"
		call :say "---- 1b. retry on %HOST%:%PORT% and %HOST%:%PORT2% (the line is already known, no second speed test) ----"
	) else (
		call :say "---- 1b. retry on %HOST%:%PORT% and %HOST%:%PORT2% ----"
	)
	"%NODE%" netbench.js !NETFLAG! %PLAYERFLAG% %UPFLAG% %A2SFLAG% --auto --out "%OUT%" > "%TMPLOG%" 2> "%TMPERR%"
	call :show "%TMPLOG%" "%TMPERR%"
	findstr /c:"players, map" "%TMPLOG%" >nul
	if errorlevel 1 (
		if defined PLAYERFLAG (
			call :say "neither !PORT! nor !PORT2! answered: slots taken from your 3rd argument (!CALPLAYERS!), not from the server"
		) else (
			call :say "neither !PORT! nor !PORT2! answered: the udp listeners line above says whether a server runs on this machine at all"
		)
	) else (
		call :say "the retry answered: the server does reply, the first pass just did not get it"
	)
)

rem ---------------- 2. basic.cfg as it was written ----------------
call :say "---- 2. basic.cfg written by step 1 ----"
if exist "%OUT%\basic.cfg" (
	if defined LEGACY call :say "note: the russian comments below can draw as garbage on this console, the file itself is fine - open it in Notepad"
	call :showfile "%OUT%\basic.cfg"
) else (
	call :say "basic.cfg missing in %OUT%"
)

rem ---------------- 3. hardware calibration ----------------
rem --a2s here too: this step is the last writer of basic.cfg, so without the
rem live slot count it would quietly rewrite the file on the guessed argument
call :say "---- 3. calibration ----"
if "%CALPLAYERS%"=="" (
	call :say "skipped: pass cal_players and cal_ai_cap as the 3rd and 4th argument"
) else if "%CALAICAP%"=="" (
	rem --auto here too: without it this step rewrites the basic.cfg that step 1
	rem chose and leaves the built-in Heavy + Balanced on disk
	"%NODE%" netbench.js --no-net --auto %UPFLAG% %A2SFLAG% --players %CALPLAYERS% --calibrate --out "%OUT%" > "%TMPLOG%" 2> "%TMPERR%"
	call :show "%TMPLOG%" "%TMPERR%"
) else (
	"%NODE%" netbench.js --no-net --auto %UPFLAG% %A2SFLAG% --players %CALPLAYERS% --ai-cap %CALAICAP% --calibrate --out "%OUT%" > "%TMPLOG%" 2> "%TMPERR%"
	call :show "%TMPLOG%" "%TMPERR%"
)

>> "%LOG%" echo ============= end =============
call :say "send back: netbench.log, out\report.json, out\basic.cfg"
call :say "the log file is utf-8, Notepad reads it as is"
exit /b 0

rem one line into the log and onto the console
:say
>> "%LOG%" echo %~1
echo %~1
exit /b 0

rem one node step: the stdout file plus the stderr file that used to be merged
rem into it. on an old console node already put the russian copy into the log
rem through the tee, so the english screen text is only typed here: appending it
rem would log the same run twice. stderr never goes through the tee, so both
rem consoles log it by hand
:show
if defined LEGACY (
	type "%~1"
	if not "%~2"=="" (
		if exist "%~2" (
			type "%~2"
			type "%~2" >> "%LOG%"
		)
	)
	exit /b 0
)
type "%~1" >> "%LOG%"
call :print "%~1"
if not "%~2"=="" if exist "%~2" (
	type "%~2" >> "%LOG%"
	type "%~2"
)
exit /b 0

rem a utf-8 file on disk: log it raw, show it through powershell
:showfile
type "%~1" >> "%LOG%"
call :print "%~1"
exit /b 0

rem powershell hands the console unicode; type is the fallback for a box where
rem it is missing or too old to do this
:print
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Encoding UTF8 -LiteralPath '%~1'"
if errorlevel 1 type "%~1"
exit /b 0

rem last resort display of the whole log
:printlog
if defined LEGACY (
	type "%LOG%"
	exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Encoding UTF8 -LiteralPath '%LOG%'"
if errorlevel 1 type "%LOG%"
exit /b 0
