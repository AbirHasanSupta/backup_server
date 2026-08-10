# Phone Backup Server (v2.4.0)

A self-hosted, high-performance photo, video, and file backup & restore ecosystem over LAN. The project consists of a feature-rich **Windows Desktop Control Center** (FastAPI backend + CustomTkinter GUI) and a **React Native / Expo Android App** that provides automatic background synchronization, differential file transfers, cross-device file restoration, and shared desktop folder access.

---

## Key Features

### 🖥️ Desktop Control Center (Python & CustomTkinter)
- **Interactive Control Dashboard**: Real-time server state management (Start/Stop/Restart), aggregate storage statistics, network IP discovery with QR code, and active upload progress tracking.
- **Device Security & Approval Queue**: Pair new Android devices via global API key with an interactive approval popup queue (`REQUIRE_APPROVAL`) and scoped per-device tokens.
- **Shared Desktop Folders**: Expose local PC directories to connected mobile clients, enabling easy file distribution across your home network.
- **TLS / HTTPS Encryption**: Built-in automatic self-signed X.509 certificate and private key generation using `cryptography` (no external OpenSSL binary required) with SHA-256 fingerprint verification.
- **Live Colored Logs & Sync History**: Real-time streaming log viewer (INFO, WARNING, ERROR) with search filtering and session-by-session backup activity history per device.
- **Light & Dark Theme Modes**: Theme switcher in settings with live UI restyling.
- **Standalone Executable**: Built-in PyInstaller script (`build.py` / `build.bat`) to compile the desktop control panel into a single Windows `.exe`.

### 📱 Android Client (Expo & React Native)
- **Differential Backup Engine**: Scans selected phone directories and sends lightweight metadata (`/files/check`) to compare against the server database and physical disk before uploading. Only missing or modified files are transferred.
- **Background Auto-Sync & WakeLock**: Continuous background service loop (`react-native-background-actions`) running on a configurable schedule (15m to 24h) with CPU `WakeLock` to prevent Wi-Fi dropouts during large transfers.
- **Restore & Cross-Device Downloader**: Browse and restore backed-up files back to local device storage, stream-preview media (images, audio, video), and download files from shared PC directories.
- **Sync History & Session Logging**: View detailed sync logs (duration, transfer size, file counts) stored locally and synced with the server.
- **Single Live Notification**: Persistent Android notification updated in real time with batch transfer progress, eliminating notification spam.

---

## Repository Architecture

```
.
├── server.py               FastAPI application entrypoint & uvicorn runner
├── desktop_app.py          CustomTkinter GUI (Dashboard, Devices, Settings, Logs, History)
├── upload.py               FastAPI router endpoints for backup, restore, discovery & auth
├── database.py             SQLite schema, device tokens, sync session tracking & migrations
├── storage.py              Disk storage management, per-device paths, SHA-256 verification
├── state.py                Thread-safe in-memory state, live log buffers & approval queue
├── config.py               Configuration manager (server_config.json loader/saver & themes)
├── ssl_utils.py            X.509 TLS certificate generator & fingerprint calculator
├── build.py / build.bat    PyInstaller build script packaging into standalone Windows EXE
├── requirements.txt        Python dependencies (fastapi, uvicorn, customtkinter, cryptography, etc.)
└── android/phone-backup/   Expo Android App (see details below)
    ├── src/app/            Expo Router screens (index, restore, history, folders, settings)
    ├── src/components/     UI components (FolderCard, ServerDiscoverySheet, SyncProgressRing, StatCard)
    ├── uploader.js         Differential sync orchestrator & chunked upload handler
    ├── downloader.js       Restore manager, file streams & shared folder browser
    ├── scanner.js          Recursive storage scanner & file extension filter
    ├── backgroundTask.js   Foreground service auto-sync engine & WakeLock execution
    ├── notificationService.js  Android persistent notification manager
    ├── serverDiscovery.js  Subnet LAN scanner for automatic server discovery
    ├── connectToServer.js  Device pairing & token negotiation logic
    ├── syncHistory.js      Local session logging & server synchronization
    ├── settings.js         AsyncStorage wrapper for server IP, tokens & sync preferences
    ├── wakeLock.js         Native Android CPU WakeLock helper
    └── plugins/            Expo config plugin (withBackgroundActionsDataSync)
```

---

## How It Works

1. **Server Launch**: The desktop app starts the FastAPI server on `0.0.0.0:8000` (or configured port) and displays server IPs, active devices, and system status.
2. **Device Pairing**: When connecting for the first time, the Android app sends device details to `/connect`. If `REQUIRE_APPROVAL` is enabled, the desktop app prompts the user to Accept or Reject the connection within 30 seconds and issues a scoped device token upon approval.
3. **Differential Check**: On sync, the phone recursively scans configured folders and posts metadata (relative path, size, modified time, SHA-256) to `/files/check`. The server verifies both the SQLite DB records and physical disk files, returning only missing or changed items.
4. **File Transfer**: The Android client uploads missing files via `/upload` (multipart) or `/upload/raw` (chunked stream with SHA-256 header validation).
5. **Restore & Distribution**: Mobile users can switch to the **Restore** tab to browse backed-up files or access PC-shared directories configured on the desktop server, downloading files back to phone storage.
6. **Background Maintenance**: A background task maintains periodic sync execution even when the screen is off or the app is closed, acquiring a CPU WakeLock during transfers.

---

## Requirements

### Server (Windows Desktop / Headless)
- **Python 3.10+**
- Install dependencies:
  ```bash
  pip install -r requirements.txt
  ```

### Android Client
- **Node.js (v18+) & npm**
- **Expo CLI** (`npx expo`)
- **Android Dev Client / EAS Build** (Native Android modules like `react-native-background-actions`, `expo-notifications`, and `expo-network` require a native build and cannot run in standard Expo Go).

---

## Running the Server

### 1. CustomTkinter Desktop Application (Recommended)
```bash
python desktop_app.py
```

### 2. Headless Server Mode
```bash
python server.py
```

*Note: On initial launch, `server_config.json` and `backup.db` are created automatically in the application data directory (or alongside the executable in portable mode).*

### 3. Building Standalone Windows Executable
To bundle the GUI server into a standalone `.exe`:
```bash
python build.py
# or
build.bat
```
The compiled binary will be saved in the `dist/` directory.

---

## Running the Android App

```bash
cd android/phone-backup
npm install
npx expo start
```

### Building the Native APK / Dev Client
Since the app relies on background services and native hardware access:

```bash
# Build development APK using EAS
eas build --profile development --platform android

# Or build standalone release APK
eas build --profile preview --platform android
```

After installing the APK on your device:
1. Open the app and navigate to **Settings**.
2. Tap **Scan LAN for Server** or enter your server's IP address and Port manually.
3. Tap **Connect & Register**.
4. Approve the connection request on the desktop application's **Devices** tab.

---

## API Surface Specification

All endpoints except `/ping` require authentication via `Authorization: Bearer <TOKEN>` (accepting global API Key or issued device token).

| Endpoint | Method | Description |
|---|---|---|
| `/ping` | `GET` | LAN server discovery & health check (returns hostname & version) |
| `/connect` | `POST` | Device registration & pairing request (triggers approval popup) |
| `/devices` | `GET` | List all approved devices and storage usage |
| `/devices/{id}` | `DELETE` | Revoke device access and remove from approved list |
| `/status` | `GET` | Server system statistics, storage usage, and active connections |
| `/status/activity` | `POST` | Update active server status/activity message |
| `/files/check` | `POST` | Batch metadata differential diffing against DB & disk |
| `/upload` | `POST` | Standard multipart file upload |
| `/upload/raw` | `POST` | Raw body stream upload with SHA-256 verification |
| `/files/list` | `GET` | Paginated/filtered file index for a specific device |
| `/files/download` | `GET` | Download backed-up file from server to device |
| `/sync/session` | `POST` | Record a completed sync session log |
| `/sync/sessions` | `GET` | Retrieve sync session history logs |
| `/sync/sessions` | `DELETE` | Clear all recorded sync session history |
| `/shared/list` | `GET` | List shared desktop PC directories |
| `/shared/{source_id}/files` | `GET` | Browse files inside a PC shared directory |
| `/shared/{source_id}/download` | `GET` | Download file from a shared desktop directory |

---

## License

MIT License. Free for personal and self-hosted open-source use.

