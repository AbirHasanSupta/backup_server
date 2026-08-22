# Phone Backup Server (v3.4.2)

A self-hosted, high-performance photo, video, and file backup & restore ecosystem over LAN. The project consists of a feature-rich **Windows Desktop Control Center** (FastAPI backend + CustomTkinter GUI) and a **React Native / Expo Android App** that provides automatic background synchronization, differential file transfers, cross-device file restoration, an "On This Day" media memories feed, video rewind reels, photo quizzes, location clusters, and shared desktop folder access.

---

## Key Features

### 🖥️ Desktop Control Center (Python & CustomTkinter)
- **Interactive Control Dashboard**: Real-time server state management (Start/Stop/Restart), aggregate storage statistics, network IP discovery with QR code, and active upload progress tracking.
- **Device Security & Approval Queue**: Pair new Android devices via global API key with an interactive approval popup queue (`REQUIRE_APPROVAL`) and scoped per-device tokens.
- **Shared Desktop Folders**: Expose local PC directories to connected mobile clients, with per-folder device tagging (`device_ids` / `all`) so each shared folder is only visible to the phones it's meant for.
- **TLS / HTTPS Encryption**: Built-in automatic self-signed X.509 certificate and private key generation using `cryptography` (no external OpenSSL binary required) with SHA-256 fingerprint verification.
- **Live Colored Logs & Sync History**: Real-time streaming log viewer (INFO, WARNING, ERROR) with search filtering and session-by-session backup activity history per device.
- **Background Media Indexer**: A daemon thread (`memories.py`) scans phone backups and tagged shared folders daily, extracting capture dates from EXIF/`ffprobe`/filesystem metadata into a SQLite cache to power Memories, Flashbacks, Places, and Rewind reels.
- **On-Demand Video Preview Cache**: `video_preview.py` streams the original file immediately over HTTP range requests while transcoding an optimized, Android-compatible MP4 in the background only when needed, so opening a large video never blocks on a full conversion.
- **Automated Video Rewind Reels**: `rewind.py` creates monthly video recap montages with dynamic background soundtrack selection and Ken Burns transitions.
- **Light & Dark Theme Modes**: Theme switcher in settings with live UI restyling.
- **Standalone Executable**: Built-in PyInstaller script (`build.py` / `build.bat`) to compile the desktop control panel into a single Windows `.exe`.

### 📱 Android Client (Expo & React Native)
- **Differential Backup Engine**: Scans selected phone directories and sends lightweight metadata (`/files/check`) to compare against the server database and physical disk before uploading. Only missing or modified files are transferred.
- **Background Auto-Sync & WakeLock**: Continuous background service loop (`react-native-background-actions`) running on a configurable schedule (15m to 24h) with CPU `WakeLock` to prevent Wi-Fi dropouts during large transfers.
- **Library & Cross-Device Downloader**: Browse and restore backed-up files back to local device storage, stream-preview media (images, audio, video), and download files from shared PC directories. The file tree is rendered as a flattened, virtualized list for smooth scrolling even with thousands of files.
- **Folder & File Type Filtering**: Dedicated Folders tab with type filters (All, Photos, Videos, PDFs, Docs, Others) and swipe gestures (swipe left to remove, right to refresh backup).
- **On This Day — Memories**: Story-style full-screen viewer for photos and videos from past years on today's date and recent days, with tap-to-advance, hold-to-pause, and save-to-device support.
- **Surprise Flashbacks & Monthly Rewind Reels**: Automated video recap montages with background music and surprise flashback photo cards.
- **Interactive Media Experiences**:
  - 🏆 **Backup Streaks**: Daily backup streak tracking with evening reminders if a sync is at risk.
  - 🗺️ **Places**: Geotagged photo map and location clusters.
  - 🎲 **Photo Roulette**: Random memory wheel spinner.
  - 🧠 **Memory Trivia Quiz**: Interactive guessing game testing memory dates and locations.
  - 🎁 **Backup Wrapped**: Annual and periodic backup summary insights and statistics.
- **Sync History & Session Logging**: Detailed sync logs (duration, transfer size, file counts) stored locally and synchronized with the server.
- **Smart Notification System**: Real-time batch progress notification without spam, plus actionable alerts for Memories, Flashbacks, Streak Risks, and Rewind Reels.

---

## Repository Architecture

```
.
├── server.py               FastAPI application entrypoint & uvicorn runner
├── desktop_app.py          CustomTkinter GUI (Dashboard, Devices, Shared Folders, Settings, Logs, History)
├── upload.py               FastAPI router endpoints for backup, restore, shared folders, memories, rewinds & auth
├── database.py             SQLite schema, device tokens, sync session tracking, media index cache & migrations
├── storage.py               Disk storage management, per-device paths, SHA-256 verification
├── memories.py              Media capture-date indexing daemon, EXIF extraction & "On This Day" queries
├── rewind.py                Automated monthly video rewind reel generator with background music
├── video_preview.py         Background video transcode + range-request preview cache manager
├── thumbnail.py             Fast on-demand image & video thumbnail generator
├── ffmpeg_utils.py          FFmpeg executable resolver and validation helper
├── state.py                 Thread-safe in-memory state, live log buffers & approval queue
├── config.py                 Configuration manager (server_config.json loader/saver & themes)
├── build.py / build.bat      PyInstaller build script packaging into standalone Windows EXE
├── requirements.txt          Python dependencies (fastapi, uvicorn, customtkinter, cryptography, Pillow, etc.)
└── android/phone-backup/     Expo Android App
    ├── src/app/              Expo Router screens:
    │   ├── index.tsx         Backup Dashboard with live progress ring & quick access widgets
    │   ├── folders.tsx       Folders & File Types configuration with swipe actions
    │   ├── restore.tsx       Library / Restore tree browser for backed-up & PC-shared files
    │   ├── history.tsx       Sync history session logger
    │   ├── settings.tsx      Server connection, sync schedule & preference settings
    │   ├── memories.tsx      Full-screen story viewer & "On This Day" recap
    │   ├── places.tsx        Geotagged photo location clustering
    │   ├── quiz.tsx          Photo trivia guessing game
    │   ├── roulette.tsx      Photo roulette random memory spinner
    │   ├── pending.tsx       New / pending files viewer and selective uploader
    │   └── wrapped.tsx       Backup Wrapped summary recap
    ├── src/components/       Reusable UI components (FolderCard, ServerDiscoverySheet, SyncProgressRing, ...)
    ├── uploader.js            Differential sync orchestrator & chunked upload handler
    ├── downloader.js          Restore manager, file streams, shared folder browser & memories API client
    ├── scanner.js             Recursive storage scanner & file extension filter
    ├── crypto.js              Pure-JS SHA-256 file hashing used by the differential engine
    ├── backgroundTask.js      Foreground service auto-sync engine & WakeLock execution
    ├── notificationService.js Android persistent & interactive notification manager
    ├── streak.js              Daily backup streak calculation and risk monitoring
    ├── widget.js              Home screen widget synchronization helper
    ├── serverDiscovery.js     Subnet LAN scanner for automatic server discovery
    ├── connectToServer.js     Device pairing & token negotiation logic
    ├── syncHistory.js         Local session logging & server synchronization
    ├── settings.js            AsyncStorage wrapper for server IP, tokens & sync preferences
    ├── wakeLock.js            Native Android CPU WakeLock helper
    └── plugins/               Expo config plugin (withBackgroundActionsDataSync)
```

---

## How It Works

1. **Server Launch**: The desktop app starts the FastAPI server on `0.0.0.0:8000` (or configured port) and displays server IPs, active devices, and system status.
2. **Device Pairing**: When connecting for the first time, the Android app sends device details to `/connect`. If `REQUIRE_APPROVAL` is enabled, the desktop app prompts the user to Accept or Reject the connection within 30 seconds and issues a scoped device token upon approval.
3. **Differential Check**: On sync, the phone recursively scans configured folders and posts metadata (relative path, size, modified time, SHA-256) to `/files/check`. The server verifies both the SQLite DB records and physical disk files, returning only missing or changed items.
4. **File Transfer**: The Android client uploads missing files via `/upload` (multipart) or `/upload/raw` (chunked stream with SHA-256 header validation).
5. **Library & Restore**: Mobile users can switch to the **Library** tab to browse backed-up files or access PC-shared directories configured on the desktop server, previewing media and downloading files back to phone storage.
6. **Media Indexing & Memories**: A background daemon thread walks phone backups and tagged shared folders daily, extracting capture dates from EXIF/metadata into SQLite. This powers:
   - **Memories**: "On This Day" photo/video stories from past years.
   - **Flashbacks**: Surprise photo cards served periodically.
   - **Rewind Reels**: Automated video montages generated on the server with background music.
   - **Places & Quizzes**: Location-based photo clustering and trivia guessing games.
7. **Video Preview Streaming**: Opening a video in Library or Memories streams the original file immediately via HTTP range requests; the server builds an optimized cached copy in the background only when needed.
8. **Background Maintenance**: A background task maintains periodic sync execution even when the screen is off or the app is closed, acquiring a CPU WakeLock during transfers.

---

## Requirements

### Server (Windows Desktop / Headless)
- **Python 3.10+**
- Install dependencies:
  ```bash
  pip install -r requirements.txt
  ```
- **FFmpeg / ffprobe** on `PATH` (optional but recommended): enables video capture-date extraction for Memories, video rewind reel generation, and background video preview transcoding.

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

*Note: On initial launch, `server_config.json` and `backup.db` are created automatically in the application data directory (or alongside the executable in portable mode). The media indexer runs its first full scan on startup, then re-scans daily.*

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

All endpoints except `/ping` require authentication via `Authorization: Bearer <TOKEN>` (accepting global API Key or issued device token, or a `?token=` query parameter for media streaming clients).

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
| `/files/preview` | `GET` | Range-request video preview stream (auto-transcoded cache when needed) |
| `/files/thumbnail` | `GET` | Fast on-demand thumbnail generation for images and videos |
| `/files/warm_previews` | `POST` | Arm the active video in a browsing session for background preview caching |
| `/sync/session` | `POST` | Record a completed sync session log |
| `/sync/sessions` | `GET` | Retrieve sync session history logs |
| `/sync/sessions` | `DELETE` | Clear all recorded sync session history |
| `/shared/list` | `GET` | List shared desktop PC directories tagged for the requesting device |
| `/shared/{source_id}/files` | `GET` | Browse files inside a PC shared directory |
| `/shared/{source_id}/download` | `GET` | Download file from a shared desktop directory |
| `/shared/{source_id}/preview` | `GET` | Range-request video preview stream for a shared-folder video |
| `/shared/{source_id}/thumbnail` | `GET` | Fast thumbnail generation for shared folder media |
| `/shared/{source_id}/warm_previews` | `POST` | Arm the active video in a shared-folder browsing session for preview caching |
| `/memories/today` | `GET` | "On This Day" photos/videos from past years for today's date |
| `/memories/recent` | `GET` | Memories grouped by day for the last N days (default 7) |
| `/memories/flashback` | `GET` | Random surprise flashback media item |
| `/memories/wrapped` | `GET` | Annual and monthly backup insights, format breakdown, and top stats |
| `/memories/quiz` | `GET` | Photo trivia questions generated from backed-up media |
| `/memories/roulette` | `GET` | Random photo selection for roulette memory spinner |
| `/memories/places` | `GET` | Geotagged photo location clusters and summaries |
| `/memories/places/{cluster_key}` | `GET` | List photos/videos within a specific geographic location cluster |
| `/memories/rewind/generate` | `POST` | Start background generation of a monthly video rewind montage with soundtrack |
| `/memories/rewind/status` | `GET` | Query generation status and progress of a video rewind reel |
| `/memories/rewind/stream` | `GET` | Stream the finished MP4 video rewind reel |
| `/memories/reindex` | `POST` | Trigger an immediate background re-scan of the media capture-date index |

---

## License

MIT License. Free for personal and self-hosted open-source use.
