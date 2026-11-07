@echo off
rem netbench: which runtime and which console language this windows can take.
rem called by netbench_run.cmd and netbench_watch.cmd, and it leaves NODE and
rem NETBENCH_SCREEN set for whoever called it.
rem
rem written on purpose WITHOUT setlocal, because the caller has to read the
rem variables this file sets, and WITH each value read on its own line, so no
rem block can mix an old value with a new one parsed before it was set.
rem
rem two different things are decided here and they must stay separate:
rem   the console of win7 / vista / 2008 / 8.1 cannot draw utf-8, so there the
rem     screen gets english labels while the files stay russian
rem   node 18 and newer do not even start before windows 10, so the runtime is
rem     chosen by that same line, but it is verified by running it
rem the choice only decides which binary is TRIED FIRST. a box that the version
rem probe gets wrong still runs, from the other runtime, with a note saying so.
set "PKDIR=%~dp0"

rem ver is localised: the bracketed part is "Version 10.0.26100.5131" on an
rem english box and the same digits behind a localised word on a russian one,
rem so the test looks for the digits anywhere in that part instead of
rem anchoring them. no 5.x or 6.x build number contains "10.", and if the
rem probe finds no brackets at all the box is treated as old, which is the
rem safe direction
set "WINVER="
for /f "tokens=2 delims=[]" %%a in ('ver') do set "WINVER=%%a"
set "NETBENCH_SCREEN=legacy"
echo %WINVER%| findstr /c:"10." >nul && set "NETBENCH_SCREEN=modern"
rem NETBENCH_MODERN=1 or =0 in the window decides by hand, for the rare build
rem where the probe is wrong. NETBENCH_LEGACY only forces the screen language
rem and is read by the caller, not here
if "%NETBENCH_MODERN%"=="1" set "NETBENCH_SCREEN=modern"
if "%NETBENCH_MODERN%"=="0" set "NETBENCH_SCREEN=legacy"

set "NODE="
if "%NETBENCH_SCREEN%"=="modern" (
	call :try "%PKDIR%node24\node.exe"
	call :try "%PKDIR%node12\node.exe"
) else (
	call :try "%PKDIR%node12\node.exe"
	call :try "%PKDIR%node24\node.exe"
)
rem older archives and hand made folders keep working: node.exe next to these
rem scripts, node\node.exe, then whatever the box has in PATH
call :try "%PKDIR%node.exe"
call :try "%PKDIR%node\node.exe"
if not defined NODE call :frompath

if defined NODE exit /b 0
echo netbench: no working node found inside %PKDIR%
echo   this build carries 64 bit runtimes, the os reports %PROCESSOR_ARCHITECTURE%
echo   put any node.exe next to these scripts, or install node, and run again
exit /b 1

:try
if defined NODE exit /b 0
if not exist "%~1" exit /b 0
"%~1" -v >nul 2>&1
if not errorlevel 1 (
	set "NODE=%~1"
	exit /b 0
)
echo note: "%~1" did not start on this windows, trying the other runtime
exit /b 0

:frompath
where node >nul 2>&1 || exit /b 0
node -v >nul 2>&1 || exit /b 0
set "NODE=node"
exit /b 0
