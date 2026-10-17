@echo off
rem Windows entry point for the unified agent launcher (cmd.exe and PowerShell).
rem Thin wrapper only: all logic stays in agent.ts. Arguments and the exit code
rem pass through unchanged.
bun "%~dp0agent.ts" %*
exit /b %ERRORLEVEL%
