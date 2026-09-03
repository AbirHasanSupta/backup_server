# Phone Backup Server (v4.3.1)

A self-hosted, high-performance photo, video, and file backup & restore ecosystem over LAN. The project consists of a feature-rich **Windows Desktop Control Center** (FastAPI backend + CustomTkinter GUI) and a **React Native / Expo Android App** that provides automatic background synchronization, differential file transfers, cross-device file restoration, device-to-device media sharing with comments and reactions, an "On This Day" media memories feed, automated video rewind reels, smart trip albums, photo quizzes, location clusters, safe local storage cleanup, and shared desktop folder access.

---

## Key Features

### 🖥️ Desktop Control Center (Python & CustomTkinter)
- **Interactive Control Dashboard**: Real-time server state management (Start/Stop/Restart), aggregate storage statistics, network IP discovery with QR code, and active upload progress tracking.
- **Device Security & Approval Queue**: Pair new Android devices via global API key with an interactive approval popup queue (`REQUIRE_APPROVAL`) and scoped per-device tokens.
- **Shared Desktop Folders**: Expose local PC directories to connected mobile clients, with per-folder device tagging (`device_ids` / `all`) so each shared folder is only visible to the phones it's meant for.
- **Device-to-Device Media Sharing**: Relay shared photo and video albums between approved mobile devices with captions, access controls, target recipient filtering, and post management.
- **Social Feedback (Reactions & Comments)**: Threaded comments and emoji reactions on backed-up and shared media items across devices, with post owner deletion moderation.
- **Smart Trip Clustering & Albums**: `trips.py` groups media into auto-curated trip albums based on temporal proximity (gap < 36h) and spatial distance (< 50km), reverse-geocoding cluster centroids into place names with a thread-safe SQLite cache.
- **Background Media Indexer**: A daemon thread (`memories.py`) scans phone backups and tagged shared folders daily, extracting capture dates and GPS from EXIF (with `pillow-heif` for HEIC/HEIF) and `ffprobe` video metadata into a SQLite cache.
- **On-Demand Video Preview Cache**: `video_preview.py` streams the original file immediately over HTTP range requests while transcoding an optimized, Android-compatible MP4 in the background only when needed, with configurable LRU cache size limits.
- **Automated Video Rewind Reels**: `rewind.py` creates monthly video recap montages with dynamic background soundtrack selection and Ken Burns transitions.
- **Safe Storage Cleanup Backend**: Endpoints (`/cleanup/candidates` and `/cleanup/delete`) verify backed-up status before local file removal and maintain audit cleanup logs.
- **System Tray Minimization & Windows Autostart**: Minimize to Windows system tray (`pystray`) and optional Windows boot autostart configuration (`winreg`).
- **TLS / HTTPS Encryption**: Built-in automatic self-signed X.509 certificate and private key generation using `cryptography` (no external OpenSSL binary required) with SHA-256 fingerprint verification.
- **Live Colored Logs & Sync History**: Real-time streaming log viewer (INFO, WARNING, ERROR) with search filtering and session-by-session backup activity history per device.
- **Light & Dark Theme Modes**: Theme switcher in settings with live UI restyling.
- **Standalone Executable**: Built-in PyInstaller script (`build.py` / `build.bat`) to compile the desktop control panel into a single Windows `.exe`.

### 📱 Android Client (Expo & React Native)
- **Differential Backup Engine**: Scans selected phone directories and sends lightweight metadata (`/files/check`) to compare against the server database and physical disk before uploading. Only missing or modified files are transferred.
- **Background Auto-Sync & WakeLock**: Continuous background service loop (`react-native-background-actions`) running on a configurable schedule (15m to 24h) with CPU `WakeLock` to prevent Wi-Fi dropouts during large transfers.
- **6-Tab Modern Navigation**: Dedicated tabs for **Backup**, **Folders**, **Library**, **Feed**, **History**, and **Settings** with fluid reanimated spring tab icons.
- **Device-to-Device Sharing Feed (`feed.tsx`)**: Browse shared media albums sent between devices, view multi-photo carousels with dot indicators, like/react with emojis, participate in comment threads, and manage shared recipients.
- **Library & Cross-Device Downloader (`restore.tsx`)**: Browse and restore backed-up files or PC-shared directories in virtualized tree or grid views, stream-preview media (images, `expo-audio`, `expo-video`), share files to peer devices, and batch-download files back to phone storage.
- **Free Up Storage Cleaner (`free-up.tsx` & `freeUpStorage.js`)**: Identifies files on the phone that are safely backed up on the server, verifies candidates against local cache and server records, filters by category (Photos, Videos, Large, Older), and deletes local copies with offline sync queue tracking.
- **Pending Backups Viewer (`pending.tsx` & `pendingBackup.js`)**: Incremental scanner showing new/unbacked files waiting for sync, with selective or batch manual upload triggers.
- **On This Day — Memories (`memories.tsx`)**: Story-style full-screen viewer for photos and videos from past years on today's date and recent days, with tap-to-advance, hold-to-pause, and save-to-device support.
- **Surprise Flashbacks & Monthly Rewind Reels**: Automated video recap montages with background music and surprise flashback photo cards.
- **Smart Trips & Places (`places.tsx`)**: Interactive geotagged photo map, location clustering, and auto-curated trip albums with place reverse-geocoding.
- **Interactive Media Experiences**:
  - 🏆 **Backup Streaks (`streak.js`)**: Daily backup streak tracking with evening reminders if a sync is at risk.
  - 🎲 **Photo Roulette (`roulette.tsx`)**: Random memory wheel spinner.
  - 🧠 **Memory Trivia Quiz (`quiz.tsx`)**: Interactive guessing game testing memory dates and locations.
  - 🎁 **Backup Wrapped (`wrapped.tsx`)**: Annual and periodic backup summary insights and statistics.
- **Sync History & Session Logging**: Detailed sync logs (duration, transfer size, file counts) stored locally and synchronized with the server.
- **Smart Notification System (`notificationService.js`)**: Real-time batch progress notification without spam, plus actionable alerts for Memories, Flashbacks, Streak Risks, and Rewind Reels.

---

## Repository Architecture

```
.
├── server.py               FastAPI application entrypoint & uvicorn runner with thread limiter
├── desktop_app.py          CustomTkinter GUI (Dashboard, Devices, Shared Folders, Settings, Logs, History)
├── upload.py               FastAPI router endpoints (backup, restore, shared folders, memories, rewinds, trips, shares, feed, comments, cleanup)
├── database.py             SQLite schema, pooled connections, device tokens, sync sessions, media index, trips, shares, comments & cleanup logs
├── storage.py               Disk storage management, per-device paths, SHA-256 verification & safe path resolution
├── trips.py                Spatial-temporal clustering, reverse geocoding (Nominatim cache) & trip album generation
├── memories.py              Media capture-date indexing daemon, EXIF extraction (HEIC/HEIF support) & "On This Day" queries
├── rewind.py                Automated monthly video rewind reel generator with background music & Ken Burns transitions
├── video_preview.py         Background video transcode + range-request preview cache manager with LRU eviction
├── thumbnail.py             Fast on-demand image & video thumbnail generator
├── ffmpeg_utils.py          FFmpeg executable resolver and validation helper
├── state.py                 Thread-safe in-memory state, live log buffers & approval queue
├── config.py                 Configuration manager (server_config.json loader/saver, theme & Windows autostart)
├── build.py / build.bat      PyInstaller build script packaging into standalone Windows EXE
├── requirements.txt          Python dependencies (fastapi, uvicorn, customtkinter, pillow, pillow-heif, pystray, etc.)
└── android/phone-backup/     Expo Android App (Expo SDK 57, React Native 0.86, React 19, TypeScript)
    ├── src/app/              Expo Router screens:
    │   ├── index.tsx         Backup Dashboard with live progress ring & quick access widgets
    │   ├── folders.tsx       Folders & File Types configuration with swipe actions
    │   ├── restore.tsx       Library / Restore tree & grid browser for backed-up & PC-shared files, file sharing & comments
    │   ├── feed.tsx          Device-to-Device Sharing Feed with carousel view, emoji reactions & comments
    │   ├── free-up.tsx       Free Up Storage screen with hybrid candidate verification & safe local deletion
    │   ├── pending.tsx       Pending / New files queue viewer and selective uploader
    │   ├── history.tsx       Sync history session logger
    │   ├── settings.tsx      Server connection, sync schedule, WakeLock & preference settings
    │   ├── memories.tsx      Full-screen story viewer, Flashbacks & Rewind Reel player
    │   ├── places.tsx        Geotagged photo location clustering & Smart Trip Albums
    │   ├── quiz.tsx          Photo trivia guessing game
    │   ├── roulette.tsx      Photo roulette random memory spinner
    │   ├── wrapped.tsx       Backup Wrapped summary recap
    │   └── _layout.tsx       Root tabs layout, deep linking & background notification listeners
    ├── src/components/       Reusable UI components (FolderCard, ServerDiscoverySheet, SyncProgressRing, AppIcon, ...)
    ├── src/constants/        App theme tokens, typography, radii, shadows, and color palettes
    ├── src/hooks/            Theme hooks (use-app-theme) & collapsible header hooks
    ├── src/utils/            Helper utilities (haptics, geocoding, error handling, preview cache manager)
    ├── uploader.js            Differential sync orchestrator & chunked upload handler
    ├── downloader.js          Restore manager, file streams, shared folders, memories, trips, shares & comments API client
    ├── scanner.js             Recursive storage scanner & file extension filter
    ├── crypto.js              Pure-JS SHA-256 file hashing used by the differential engine
    ├── freeUpStorage.js       Client-side storage cleaner engine, candidate verification & offline deletion queue
    ├── pendingBackup.js       Incremental scanner for pending/unbacked files and summary cache
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
5. **Library & Restore**: Mobile users browse backed-up files or PC-shared directories in the **Library** tab, previewing media and downloading files back to phone storage.
6. **Device-to-Device Sharing & Feed**: Users select backed-up photos/videos in the Library, add a caption, and share them to specific approved devices. Recipients view these in the **Feed** tab, react with emojis, and leave comments.
7. **Free Up Storage**: The app scans device storage, verifies with the server via `/cleanup/candidates` that copies exist safely on the server, and allows users to delete local files while queuing deletion reports to `/cleanup/delete`.
8. **Media Indexing, Memories & Trips**: A background daemon thread indexes media capture dates and GPS metadata. This powers:
   - **Memories**: "On This Day" photo/video stories from past years.
   - **Flashbacks**: Surprise photo cards served periodically.
   - **Rewind Reels**: Automated video montages generated on the server with background music.
   - **Trips & Places**: Automated trip album clustering based on date and geographical proximity, plus map clusters.
   - **Quizzes & Roulette**: Photo trivia guessing games and random memory wheels.
9. **Video Preview Streaming**: Opening a video in Library, Feed, or Memories streams the original file immediately via HTTP range requests; the server builds an optimized cached copy in the background only when needed.
10. **Background Maintenance**: A background task maintains periodic sync execution even when the screen is off or the app is closed, acquiring a CPU WakeLock during transfers.

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

# Or build standalone preview APK
npm run build:apk
# or
eas build --profile preview --platform android

# Or build production release APK
npm run build:apk:prod
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
| **Server & Device Management** | | |
| `/ping` | `GET` | LAN server discovery & health check (returns hostname & version) |
| `/connect` | `POST` | Device registration & pairing request (triggers approval popup) |
| `/devices` | `GET` | List all approved devices and storage usage |
| `/devices/{id}` | `DELETE` | Revoke device access and remove from approved list |
| `/status` | `GET` | Server system statistics, storage usage, and active connections |
| `/status/activity` | `POST` | Update active server status/activity message |
| **File Synchronization & Browsing** | | |
| `/files/check` | `POST` | Batch metadata differential diffing against DB & disk |
| `/upload` | `POST` | Standard multipart file upload |
| `/upload/raw` | `POST` | Raw body stream upload with SHA-256 verification |
| `/files/list` | `GET` | Paginated/filtered file index for a specific device |
| `/files/browse` | `GET` | Prefix-based directory tree browse for device backups |
| `/files/search` | `GET` | Search backed-up files by filename query |
| `/files/download` | `GET` | Download backed-up file from server to device |
| `/files/preview` | `GET` | Range-request video preview stream (auto-transcoded cache when needed) |
| `/files/thumbnail` | `GET` | Fast on-demand thumbnail generation for images and videos |
| `/files/warm_previews` | `POST` | Arm the active video in a browsing session for background preview caching |
| **Sync Session History** | | |
| `/sync/session` | `POST` | Record a completed sync session log |
| `/sync/sessions` | `GET` | Retrieve sync session history logs |
| `/sync/sessions` | `DELETE` | Clear all recorded sync session history |
| **Shared Desktop Folders** | | |
| `/shared/list` | `GET` | List shared desktop PC directories tagged for the requesting device |
| `/shared/{source_id}/files` | `GET` | Flat file listing inside a PC shared directory |
| `/shared/{source_id}/browse` | `GET` | Hierarchical folder browser inside a PC shared directory |
| `/shared/{source_id}/search` | `GET` | Search files inside a PC shared directory |
| `/shared/{source_id}/download` | `GET` | Download file from a shared desktop directory |
| `/shared/{source_id}/preview` | `GET` | Range-request video preview stream for a shared-folder video |
| `/shared/{source_id}/thumbnail` | `GET` | Fast thumbnail generation for shared folder media |
| `/shared/{source_id}/warm_previews` | `POST` | Arm the active video in a shared-folder browsing session for preview caching |
| **Storage Cleanup (Free Up Space)** | | |
| `/cleanup/candidates` | `GET` | Verify that scanned local device files exist safely on the server |
| `/cleanup/delete` | `POST` | Report local deletions to record in the server audit cleanup log |
| **Memories, Flashbacks & Rewinds** | | |
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
| **Smart Trip Albums** | | |
| `/api/trips` | `GET` | List auto-curated trip albums for a device |
| `/api/trips/{trip_id}/media` | `GET` | Retrieve photos and videos within a specific trip album |
| `/api/trips/recluster` | `POST` | Manually trigger trip clustering for a device |
| **Social Feedback (Reactions & Comments)** | | |
| `/api/media/{media_id}/react` | `POST` | Toggle an emoji reaction on a media item |
| `/api/media/{media_id}/reactions` | `GET` | Retrieve reaction counts and user reaction state for a media item |
| `/api/media/{media_id}/comments` | `GET` | Retrieve comment thread for a media item |
| `/api/media/{media_id}/comments` | `POST` | Add a comment to a media item |
| `/api/comments/{comment_id}/delete` | `POST` | Delete a comment (allowed for comment author or media owner) |
| **Device-to-Device Sharing & Feed** | | |
| `/api/share/devices` | `GET` | List peer devices available to receive shares |
| `/api/share/create` | `POST` | Share media items/albums with selected target devices and optional caption |
| `/api/feed` | `GET` | Paginated social feed of received and sent shares with media, reactions & comments |
| `/api/share/group/{group_id}/targets` | `GET` | List target devices for a shared album group |
| `/api/share/group/{group_id}/delete` | `POST` | Delete a share group and all its items (sharer only) |
| `/api/share/group/{group_id}/remove_target` | `POST` | Remove a recipient target from a share group |
| `/api/share/{share_id}/delete` | `POST` | Delete an individual share item |
| `/api/share/{share_id}/remove_target` | `POST` | Remove a recipient target from an individual share |
| `/api/share/{share_id}/download` | `GET` | Download a shared media item |
| `/api/share/{share_id}/preview` | `GET` | Range-request video preview stream for a shared video |
| `/api/share/{share_id}/thumbnail` | `GET` | Thumbnail generation for shared media |

---

## License

MIT License. Free for personal and self-hosted open-source use.
