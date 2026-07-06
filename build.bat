@echo off
setlocal enabledelayedexpansion

echo.
echo =====================================================
echo   Phone Backup Server ^| PyInstaller Build
echo =====================================================
echo.

:: ── Locate the project root (same folder as this script) ──────────────────
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "VENV=%ROOT%\.venv"
set "DIST=%ROOT%\dist"
set "BUILD=%ROOT%\build"
set "OUT=%ROOT%\PhoneBackupServer.exe"

:: ── Activate virtual environment ──────────────────────────────────────────
if exist "%VENV%\Scripts\activate.bat" (
    echo [1/5] Activating virtual environment...
    call "%VENV%\Scripts\activate.bat"
) else (
    echo [WARN] No .venv found — using system Python
)

:: ── Ensure PyInstaller is installed ───────────────────────────────────────
echo [2/5] Checking PyInstaller...
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo       Installing PyInstaller...
    pip install pyinstaller --quiet
)

:: ── Clean previous build artefacts ───────────────────────────────────────
echo [3/5] Cleaning previous build...
if exist "%DIST%" rmdir /s /q "%DIST%"
if exist "%BUILD%" rmdir /s /q "%BUILD%"
if exist "%OUT%" del /q "%OUT%"

:: ── Run PyInstaller ───────────────────────────────────────────────────────
echo [4/5] Building executable (this may take 2-3 minutes)...
echo.

python -m PyInstaller ^
    --noconfirm ^
    --onefile ^
    --windowed ^
    --name "PhoneBackupServer" ^
    --icon "%ROOT%\assets\icon.ico" ^
    --add-data "%ROOT%\assets;assets" ^
    --collect-all customtkinter ^
    --hidden-import uvicorn ^
    --hidden-import uvicorn.logging ^
    --hidden-import uvicorn.loops ^
    --hidden-import uvicorn.loops.auto ^
    --hidden-import uvicorn.protocols ^
    --hidden-import uvicorn.protocols.http ^
    --hidden-import uvicorn.protocols.http.auto ^
    --hidden-import uvicorn.protocols.websockets ^
    --hidden-import uvicorn.protocols.websockets.auto ^
    --hidden-import uvicorn.lifespan ^
    --hidden-import uvicorn.lifespan.on ^
    --hidden-import fastapi ^
    --hidden-import multipart ^
    --hidden-import aiofiles ^
    --hidden-import anyio ^
    --hidden-import anyio._backends._asyncio ^
    --hidden-import starlette ^
    --hidden-import starlette.routing ^
    --hidden-import starlette.middleware ^
    --hidden-import starlette.responses ^
    --hidden-import starlette.requests ^
    --hidden-import httptools ^
    --hidden-import watchfiles ^
    --hidden-import websockets ^
    --add-data "%ROOT%\config.py;." ^
    --add-data "%ROOT%\database.py;." ^
    --add-data "%ROOT%\state.py;." ^
    --add-data "%ROOT%\storage.py;." ^
    --add-data "%ROOT%\upload.py;." ^
    --add-data "%ROOT%\server.py;." ^
    "%ROOT%\desktop_app.py"

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed! Check the output above for details.
    pause
    exit /b 1
)

:: ── Copy EXE to project root for convenience ──────────────────────────────
echo.
echo [5/5] Copying output to project root...
if exist "%DIST%\PhoneBackupServer.exe" (
    copy /y "%DIST%\PhoneBackupServer.exe" "%OUT%" >nul
    echo.
    echo =====================================================
    echo   BUILD SUCCESSFUL!
    echo   Output: %OUT%
    echo =====================================================
    echo.
    echo   File size:
    for %%F in ("%OUT%") do echo     %%~zF bytes  (~%%~zF / 1048576 MB)
    echo.
) else (
    echo [ERROR] Expected output not found at %DIST%\PhoneBackupServer.exe
    pause
    exit /b 1
)

echo   Done. You can now distribute PhoneBackupServer.exe
echo   Users do NOT need Python installed.
echo.
pause
