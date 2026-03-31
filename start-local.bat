@echo off
setlocal EnableExtensions

set "REPO_ROOT=%~dp0"
set "ENGINE_DIR=%REPO_ROOT%engine"
set "WEB_DIR=%REPO_ROOT%web"
set "ENGINE_URL=http://127.0.0.1:8000"
set "DRY_RUN=0"
set "NO_INSTALL=0"
set "FORCE_INSTALL=0"

if /I "%~1"=="--dry-run" set "DRY_RUN=1"
if /I "%~1"=="--no-install" set "NO_INSTALL=1"
if /I "%~1"=="--force-install" set "FORCE_INSTALL=1"
if /I "%~2"=="--dry-run" set "DRY_RUN=1"
if /I "%~2"=="--no-install" set "NO_INSTALL=1"
if /I "%~2"=="--force-install" set "FORCE_INSTALL=1"

call :banner
call :check_command python "Python"
if errorlevel 1 goto :fail
call :check_command npm "npm"
if errorlevel 1 goto :fail

if "%NO_INSTALL%"=="0" (
  call :install_backend
  if errorlevel 1 goto :fail
  call :install_frontend
  if errorlevel 1 goto :fail
) else (
  echo [skip] Dependency installation skipped by --no-install
)

call :write_frontend_env
if errorlevel 1 goto :fail

call :launch_engine
if errorlevel 1 goto :fail
call :launch_web
if errorlevel 1 goto :fail
echo [6/6] Opening browser...
if "%DRY_RUN%"=="1" (
  echo start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
) else (
  start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 4; Start-Process 'http://localhost:3000'"
  if errorlevel 1 goto :fail
)

echo.
echo [done] Media Cleaner Lab is starting.
echo [open] http://localhost:3000
exit /b 0

:banner
echo.
echo ==============================================
echo   Media Cleaner Lab - One Click Starter
echo ==============================================
echo   Repo: %REPO_ROOT%
echo   Engine: %ENGINE_URL%
echo.
exit /b 0

:check_command
where %~1 >nul 2>nul
if errorlevel 1 (
  echo [error] %~2 was not found in PATH.
  exit /b 1
)
echo [ok] %~2 detected.
exit /b 0

:install_backend
echo [1/4] Installing backend dependencies...
call :backend_ready
if "%ERRORLEVEL%"=="0" if not "%FORCE_INSTALL%"=="1" (
  echo [skip] Backend dependencies already available.
  exit /b 0
)
if "%DRY_RUN%"=="1" (
  echo python -m pip install -r "%ENGINE_DIR%\requirements.txt"
  exit /b 0
)
pushd "%ENGINE_DIR%" || exit /b 1
python -m pip install --disable-pip-version-check -r requirements.txt
set "ERR=%ERRORLEVEL%"
popd
if not "%ERR%"=="0" exit /b %ERR%
exit /b 0

:install_frontend
echo [2/4] Installing frontend dependencies...
call :frontend_ready
if "%ERRORLEVEL%"=="0" if not "%FORCE_INSTALL%"=="1" (
  echo [skip] Frontend dependencies already available.
  exit /b 0
)
if "%DRY_RUN%"=="1" (
  echo npm install --prefix "%WEB_DIR%"
  exit /b 0
)
pushd "%WEB_DIR%" || exit /b 1
call npm install --no-audit --no-fund
set "ERR=%ERRORLEVEL%"
popd
if not "%ERR%"=="0" exit /b %ERR%
exit /b 0

:write_frontend_env
echo [3/4] Writing frontend environment...
if "%DRY_RUN%"=="1" (
  echo NEXT_PUBLIC_ENGINE_URL=%ENGINE_URL%^> "%WEB_DIR%\.env.local"
  exit /b 0
)
>"%WEB_DIR%\.env.local" echo NEXT_PUBLIC_ENGINE_URL=%ENGINE_URL%
if errorlevel 1 (
  echo [error] Failed to write "%WEB_DIR%\.env.local"
  exit /b 1
)
exit /b 0

:launch_engine
echo [4/6] Launching backend window...
if "%DRY_RUN%"=="1" (
  echo start "Media Cleaner Engine" cmd /k "cd /d ""%ENGINE_DIR%"" ^&^& python -m uvicorn app.main:app --reload"
  exit /b 0
)
start "Media Cleaner Engine" cmd /k "cd /d ""%ENGINE_DIR%"" && python -m uvicorn app.main:app --reload"
if errorlevel 1 (
  echo [error] Failed to launch backend window.
  exit /b 1
)
exit /b 0

:launch_web
echo [5/6] Launching frontend window...
if "%DRY_RUN%"=="1" (
  echo start "Media Cleaner Web" cmd /k "cd /d ""%WEB_DIR%"" ^&^& set NEXT_PUBLIC_ENGINE_URL=%ENGINE_URL% ^&^& npm run dev"
  exit /b 0
)
start "Media Cleaner Web" cmd /k "cd /d ""%WEB_DIR%"" && set NEXT_PUBLIC_ENGINE_URL=%ENGINE_URL% && npm run dev"
if errorlevel 1 (
  echo [error] Failed to launch frontend window.
  exit /b 1
)
exit /b 0

:backend_ready
python -c "import importlib.util,sys;mods=['fastapi','uvicorn','multipart','numpy','cv2'];sys.exit(0 if all(importlib.util.find_spec(m) for m in mods) else 1)" >nul 2>nul
exit /b %ERRORLEVEL%

:frontend_ready
if exist "%WEB_DIR%\node_modules\next\package.json" if exist "%WEB_DIR%\node_modules\react\package.json" exit /b 0
exit /b 1

:fail
echo.
echo [failed] Startup aborted.
pause
exit /b 1
