"""
build.py — Phone Backup Server | PyInstaller Build
Run with:  python build.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path


# ── Paths ──────────────────────────────────────────────────────────────────────
ROOT  = Path(__file__).resolve().parent
VENV  = ROOT / ".venv"
DIST  = ROOT / "dist"
BUILD = ROOT / "build"
OUT   = ROOT / "PhoneBackupServer.exe"

SEP = "=" * 53


def banner(msg: str) -> None:
    print(f"\n{SEP}\n  {msg}\n{SEP}\n")


def step(n: int, total: int, msg: str) -> None:
    print(f"[{n}/{total}] {msg}")


def run(*args: str, check: bool = True) -> int:
    """Run a subprocess command, streaming output live."""
    result = subprocess.run(args, check=False)
    if check and result.returncode != 0:
        print(f"\n[ERROR] Command failed with exit code {result.returncode}:")
        print("  " + " ".join(args))
        sys.exit(result.returncode)
    return result.returncode


def resolve_python() -> str:
    """Return the Python executable inside .venv, falling back to system Python."""
    candidates = [
        VENV / "Scripts" / "python.exe",   # Windows
        VENV / "bin" / "python",           # Linux/macOS
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    print("[WARN] No .venv found — using system Python")
    return sys.executable


def main() -> None:
    banner("Phone Backup Server | PyInstaller Build")

    # ── 1. Resolve Python interpreter ────────────────────────────────────────
    step(1, 5, "Resolving Python interpreter...")
    python = resolve_python()
    print(f"      Using: {python}")

    # ── 2. Ensure PyInstaller is installed ───────────────────────────────────
    step(2, 5, "Checking PyInstaller...")
    rc = run(python, "-m", "PyInstaller", "--version", check=False)
    if rc != 0:
        print("      Installing PyInstaller...")
        run(python, "-m", "pip", "install", "pyinstaller", "--quiet")

    # ── 3. Clean previous build artefacts ────────────────────────────────────
    step(3, 5, "Cleaning previous build...")
    for path in (DIST, BUILD):
        if path.exists():
            shutil.rmtree(path)
            print(f"      Removed: {path}")
    if OUT.exists():
        OUT.unlink()
        print(f"      Removed: {OUT}")

    # ── 4. Run PyInstaller ───────────────────────────────────────────────────
    step(4, 5, "Building executable (this may take 2-3 minutes)...")
    print()

    # Helper to format --add-data with OS-correct separator
    sep = ";" if sys.platform == "win32" else ":"

    hidden_imports = [
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi",
        "multipart",
        "anyio",
        "anyio._backends._asyncio",
        "starlette",
        "starlette.routing",
        "starlette.middleware",
        "starlette.responses",
        "starlette.requests",
    ]

    add_data_files = [
        "config.py",
        "database.py",
        "state.py",
        "storage.py",
        "upload.py",
        "server.py",
    ]

    cmd = [
        python, "-m", "PyInstaller",
        "--noconfirm",
        "--onefile",
        "--windowed",
        "--name", "PhoneBackupServer",
        "--icon", str(ROOT / "assets" / "icon.ico"),
        "--add-data", f"{ROOT / 'assets'}{sep}assets",
        "--collect-all", "customtkinter",
    ]

    for imp in hidden_imports:
        cmd += ["--hidden-import", imp]

    for src in add_data_files:
        cmd += ["--add-data", f"{ROOT / src}{sep}."]

    cmd.append(str(ROOT / "desktop_app.py"))

    run(*cmd)

    # ── 5. Copy EXE to project root ──────────────────────────────────────────
    step(5, 5, "Copying output to project root...")
    built_exe = DIST / "PhoneBackupServer.exe"
    if not built_exe.exists():
        print(f"[ERROR] Expected output not found at: {built_exe}")
        sys.exit(1)

    shutil.copy2(built_exe, OUT)
    size_bytes = OUT.stat().st_size
    size_mb    = size_bytes / (1024 * 1024)

    print(f"\n{SEP}")
    print("  BUILD SUCCESSFUL!")
    print(f"  Output: {OUT}")
    print(f"{SEP}")
    print(f"\n  File size: {size_bytes:,} bytes  (~{size_mb:.1f} MB)")
    print("\n  Done. You can now distribute PhoneBackupServer.exe")
    print("  Users do NOT need Python installed.\n")


if __name__ == "__main__":
    main()
