@echo off
rem netbench watch - sample the live numbers all day and print the verdict at the end
rem nothing is written into the server: only windows counters + an A2S query
rem ASCII only: cmd reads this file in the oem codepage, cyrillic can turn a
rem comment into a command
rem
rem usage: netbench_watch.cmd [minutes] [every_sec] [ip:port ...]
rem   netbench_watch.cmd                 24 h, every 30 s, 2302+2303 and 2402+2403
rem   netbench_watch.cmd 720             12 h
rem   netbench_watch.cmd 720 60          12 h, every 60 s
rem   netbench_watch.cmd 1440 30 127.0.0.1:2402
rem   netbench_watch.cmd 127.0.0.1:2302
rem                                    addresses only: 24 h and 30 s stay default.
rem                                    each address is also asked one port higher,
rem                                    so naming the game port or the query port
rem                                    both reach the running server
rem   netbench_watch.cmd report          verdict from the rows collected so far
rem stop early: create an empty file out\watch\STOP - the summary still prints.
rem ctrl-c kills the sampler, rows already on disk stay, run "report" afterwards
setlocal enabledelayedexpansion

set "DIR=%~dp0"
set "OUT=%DIR%out"
set "LOG=%DIR%netbench_watch.log"
set "TMPERR=%TEMP%\netbench_watch_err.txt"
cd /d "%DIR%"

rem picknode.cmd decides two separate things for this windows: which bundled
rem runtime actually starts here, and whether this console can draw utf-8. it
rem leaves NODE and NETBENCH_SCREEN set
call "%DIR%picknode.cmd"
if errorlevel 1 exit /b 1

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

rem addresses from the first slot on: an address has a colon, a minute count
rem does not. without this shift the address would reach the sampler as the
rem run time
set "ADDR_FIRST="
echo %~1| findstr /c:":" >nul && set "ADDR_FIRST=1"

set "MODE=%~1"
set "EVERY=%~2"
if defined ADDR_FIRST (
	set "MODE=1440"
	set "EVERY=30"
)
if "%MODE%"=="" set "MODE=1440"
if "%EVERY%"=="" set "EVERY=30"

rem bi numbers the steam query port as game+1 and the game port itself never
rem answers a query, so asking 127.0.0.1:2302 alone records silence all day on a
rem box where the server is alive one port away. every named address is therefore
rem also asked one port up. the sampler sums the players of every address that
rem answers, so a server may only enter the list once: the port above is skipped
rem when the caller already named it, or when the port below was named (that
rem address is the query port of something already on the list).
rem first pass records what was given, second pass builds the flags
set "GIVEN= "
if defined ADDR_FIRST (
	call :noteaddr %~1
	call :noteaddr %~2
	call :noteaddr %~3
	call :noteaddr %~4
) else if not "%~3"=="" (
	call :noteaddr %~3
	call :noteaddr %~4
	call :noteaddr %~5
	call :noteaddr %~6
)
if "!GIVEN!"==" " (
	call :noteaddr 127.0.0.1:2302
	call :noteaddr 127.0.0.1:2402
)
set "A2SFLAGS= "
for %%a in (!GIVEN!) do call :addaddr %%a

if /i "%MODE%"=="report" goto report
echo !MODE!| findstr /r /c:"^[0-9][0-9]*$" >nul || (
	echo first argument is the run time in minutes, a number like 1440 or 720,
	echo or the word report. addresses go after the interval:
	echo   netbench_watch.cmd 1440 30 127.0.0.1:2302 127.0.0.1:2402
	echo   netbench_watch.cmd 127.0.0.1:2302 127.0.0.1:2402
	exit /b 2
)
echo !EVERY!| findstr /r /c:"^[0-9][0-9]*$" >nul || (
	echo second argument is the sampling interval in seconds, a plain number
	echo   netbench_watch.cmd 1440 30 127.0.0.1:2302
	exit /b 2
)

:sample
echo watching for %MODE% minutes, one row every %EVERY% s
echo rows:   %OUT%\watch\samples.csv
echo log:    %LOG%
if defined LEGACY (
	echo the rows print here live; on a newer console they only reach the log
	rem screen gets the english rows live, the tee writes the russian copy,
	rem stderr is outside the tee so it is appended by hand afterwards
	"%NODE%" netbench.js --watch %MODE% --every %EVERY% %A2SFLAGS% --out "%OUT%" 2> "%TMPERR%"
	call :showerr
) else (
	echo live:   notepad %LOG%
	echo summary after the time is up, or run: netbench_watch.cmd report
	"%NODE%" netbench.js --watch %MODE% --every %EVERY% %A2SFLAGS% --out "%OUT%" > "%LOG%" 2>&1
	call :show "%LOG%"
)
goto end

:report
set "RPT=%TEMP%\netbench_report.txt"
if defined LEGACY (
	"%NODE%" netbench.js --report %A2SFLAGS% --out "%OUT%" 2> "%TMPERR%"
	call :showerr
) else (
	"%NODE%" netbench.js --report %A2SFLAGS% --out "%OUT%" > "%RPT%" 2> "%TMPERR%"
	call :show "%RPT%"
	call :showerr
)
goto end

:end
exit /b 0

rem a utf-8 chunk shown through powershell, which hands the console unicode
rem (OutputEncoding matters too: without it powershell re-encodes to the oem
rem codepage whenever its output is redirected into a pipe or a file)
:show
if defined LEGACY (
	type "%~1"
	exit /b 0
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Content -Encoding UTF8 -LiteralPath '%~1'"
if errorlevel 1 type "%~1"
exit /b 0

rem first pass: keep the addresses that really look like host:port, name the
rem ones that do not (a typo like 127.0.0.12302 is missing its colon)
:noteaddr
if "%~1"=="" exit /b 0
echo %~1| findstr /r /c:"^[0-9A-Za-z._-]*:[0-9][0-9]*$" >nul || (
	echo skipped "%~1": expected host:port with a numeric port, like 127.0.0.1:2402
	exit /b 0
)
set "NT=%~1"
set "GIVEN=!GIVEN!!NT! "
exit /b 0

rem second pass: the address as named, plus one port up, unless the caller
rem already named that neighbour or named the port below (then this address
rem itself is the neighbour's query port and the pair is already complete)
:addaddr
set "AD=%~1"
for /f "tokens=1,2 delims=:" %%a in ("%~1") do (
	set "WH=%%a"
	set "WP=%%b"
)
set "A2SFLAGS=!A2SFLAGS!--a2s !AD! "
set /a UP=WP+1
set /a DOWN=WP-1
echo !GIVEN!| findstr /c:" !WH!:!UP! " >nul && exit /b 0
echo !GIVEN!| findstr /c:" !WH!:!DOWN! " >nul && exit /b 0
if !UP! GTR 65535 exit /b 0
set "A2SFLAGS=!A2SFLAGS!--a2s !WH!:!UP! "
exit /b 0

rem errors never pass through the tee, so they are shown and logged in one go
:showerr
if not exist "%TMPERR%" exit /b 0
for %%f in ("%TMPERR%") do if %%~zf==0 exit /b 0
type "%TMPERR%"
type "%TMPERR%" >> "%LOG%"
exit /b 0
