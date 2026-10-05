@echo off
rem cmd.exe looks for "node" in the current folder before PATH; that folder
rem may be an untrusted repo, so turn the lookup off and resolve node from PATH.
setlocal
set NoDefaultCurrentDirectoryInExePath=1
set "ZEROSTEL_NODE="
for %%I in (node.exe) do set "ZEROSTEL_NODE=%%~$PATH:I"
if not defined ZEROSTEL_NODE (
  echo zerostel: node.exe was not found on PATH 1>&2
  exit /b 1
)
"%ZEROSTEL_NODE%" "%~dp0cli.js" %*
