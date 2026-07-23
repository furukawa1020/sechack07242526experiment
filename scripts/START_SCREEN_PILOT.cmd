@echo off
setlocal
cd /d "%~dp0\.."
set "NODE_ENV=production"
set "NODE_OPTIONS="
set "NODE_PATH="
set "ESBUILD_BINARY_PATH="
set "EXPERIMENT_CONFIG_PATH="
set "DATA_DIRECTORY="
set "NPM_CONFIG_NODE_OPTIONS="
set "TSX_TSCONFIG_PATH="
set "SECHACK_SCREEN_PILOT_SOURCE_COMMIT="
set "SECHACK_SCREEN_PILOT_SOURCE_TREE_SHA256="
set "SECHACK_SCREEN_PILOT_CONFIG_FILE_HASH="
set "SECHACK_SCREEN_PILOT_BUILD_CHALLENGE_SHA256="
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo Required Node.js runtime not found: %ProgramFiles%\nodejs\node.exe 1>&2
  exit /b 1
)
"%ProgramFiles%\nodejs\node.exe" --import tsx scripts\screen-pilot-launcher.ts
exit /b %errorlevel%
