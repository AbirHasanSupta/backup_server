# Phone Backup Server

A self-hosted, LAN-only photo/video/file backup system. A Windows desktop app runs a FastAPI server that receives files pushed from an Android app over Wi-Fi, using metadata-based diffing so only new or missing files are ever transferred.

Two components live in this repo:

- **`/`** — Python desktop server app (FastAPI backend + CustomTkinter GUI)
- **`android/phone-backup`** — Expo/React Native Android app that scans the phone and pushes files to the server

## How it works

1. The desktop app starts a FastAPI server on the local network and shows a live dashboard (devices, transfer logs, current activity).
2. The Android app discovers the server on the LAN (or connects via saved IP), registers itself, and waits for approval (first connection only).
3. On each sync, the phone scans selected folders/file types and sends **metadata only** (path, size, modified time, optional SHA-256) to `/files/check`.
4. The server checks its SQLite database *and* the actual file on disk — a file is only "present" if both agree. Anything missing or changed is requested.
5. The phone uploads only the missing/changed files to `/upload`. Deleted-on-server files are automatically restored on the next sync without re-uploading everything else.
6. A background task (`react-native-background-actions`) keeps this running on a timer even when the app isn't in the foreground, with live progress notifications instead of one notification per file.

## Repo layout

```
.
├── server.py           FastAPI app entrypoint (uvicorn)
├── desktop_app.py      CustomTkinter GUI wrapping the server (dashboard, devices, settings, logs)
├── upload.py           API routes: /ping, /connect, /devices, /status, /files/check, /upload
├── database.py         SQLite schema, migrations, file/device queries
├── storage.py          Disk I/O — file existence checks, SHA-256, saving uploads per device
├── state.py            In-memory shared state — logs, current activity, pending connection approvals
├── config.py           server_config.json load/save (API key, backup root, host/port, approval mode)
├── build.py / build.bat PyInstaller packaging into a single .exe
├── requirements.txt     fastapi, uvicorn, python-multipart, customtkinter, pyinstaller, pillow
└── android/phone-backup Expo Android app (see below)
```

### Android app (`android/phone-backup`)

Expo Router + TypeScript app (Expo SDK 57 / React Native 0.86).

```
src/app/            index (dashboard), folders, settings screens (expo-router)
src/components/     FolderCard, ServerDiscoverySheet, SyncProgressRing, StatCard, ...
scanner.js          Walks device folders, filters by selected file types
serverDiscovery.js  LAN scan (expo-network) to find a running server by /ping
connectToServer.js  Registers the device with the server, handles approval wait
uploader.js         Calls /files/check and /upload
backgroundTask.js   Foreground service loop (react-native-background-actions) — periodic auto-sync
notificationService.js  Live progress notification (single, updating) instead of per-file spam
crypto.js           SHA-256 hashing for file integrity
settings.js         Persisted app settings (server IP/port, sync interval, folders, file types)
wakeLock.js         Helper module to acquire/release Android CPU WakeLock during background sync
plugins/            Config plugin (`withBackgroundActionsDataSync`) for native Android integration
```

## Requirements

**Server (desktop):**
- Python 3.10+
- `pip install -r requirements.txt`

**Android app:**
- Node.js + npm
- Expo CLI (`npx expo`)
- A dev client or EAS build — several native modules (`expo-notifications`, `expo-network`, `react-native-background-actions`) are unavailable in Expo Go

## Running the server

```bash
pip install -r requirements.txt
python desktop_app.py     # GUI app (recommended)
# or headless:
python server.py
```

First run creates `server_config.json` next to `config.py` with defaults (API key, backup root `D:\PhoneBackup`, port 8000, approval required). Edit these from the desktop app's Settings tab or the JSON file directly.

To build a standalone Windows executable:

```bash
python build.py
# or
build.bat
```

## Running the Android app

```bash
cd android/phone-backup
npm install
npx expo start
```

Since the app relies on native modules not present in Expo Go, use a development build:

```bash
eas build --profile development --platform android
```

Then open Settings in the app, enter/discover the server's LAN IP and port, and connect. New devices must be approved from the desktop app's Devices tab (unless `REQUIRE_APPROVAL` is disabled in config).

## API surface

| Endpoint | Method | Purpose |
|---|---|---|
| `/ping` | GET | LAN discovery / health check |
| `/connect` | POST | Register device, wait for desktop approval |
| `/devices` | GET / DELETE `/devices/{id}` | List / remove known devices |
| `/status` | GET | Aggregate server + device stats |
| `/files/check` | POST | Batch metadata diff against DB + disk |
| `/upload` | POST | Upload a single file (multipart) |

All routes except `/ping` require `Authorization: Bearer <API_KEY>`.
