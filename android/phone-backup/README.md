# Phone Backup - Android Client

React Native & Expo client app for the **Phone Backup Server**. Built with Expo SDK 57, React Native 0.86, React 19, TypeScript, and Expo Router.

For server backup and restore, the client pairs with an approved Phone Backup
Server device profile. It supports LAN discovery and saved Tailscale/WireGuard
endpoints, device-scoped authentication, resumable large-file uploads,
background sync, media restore, and the social/memory features provided by the
companion server. Separately, Android builds can pair directly with nearby
phones over local Wi-Fi for P2P sharing.

## Configuration and release version

- `app.json` is the human-readable base Expo configuration.
- `app.config.js` loads that base and derives the Expo `version` and Android
  `versionCode` from the nearest semantic Git tag (with fallbacks to a bundled
  `VERSION` file and `package.json`). Do not add version fields to `app.json`.
- Run `npm run version:sync` before EAS builds so `package.json` matches the tag;
  EAS archives omit `.git`, so the builder relies on that synced metadata. It is
  already run by `npm run start`, `npm run android`, and the APK build scripts.
- Use a tag formatted as `vMAJOR.MINOR.PATCH`. Android's version code is derived
  as `major * 1,000,000 + minor * 1,000 + patch`.
- For direct Google Drive access while offline or in P2P mode, users can paste
  a Drive API key in the add-folder sheet. Builds may instead provide
  `EXPO_PUBLIC_GOOGLE_DRIVE_API_KEY` as a default. A connected server uses its
  own configured key. The build-time key is visible in the installed app, so
  use a separate key restricted to the Drive API and this Android app's
  package/signing certificate. Shared folders must allow anyone with the link.

---

## Features & App Structure

### 🗂️ 5-Tab Modern Navigation (`src/app/_layout.tsx`)
- 📊 **Backup Dashboard (`src/app/index.tsx`)**:
  - Live animated circular progress ring with real-time sync state.
  - One-tap quick actions: Manual Sync Now, Server Discovery, and Pairing.
  - Storage statistics cards (backed-up files count, transferred bytes, server connection state).
  - Custom device display username card with inline editor dialog (`/devices/{id}/username`).
  - Quick launch cards and widgets: **Free Up Space**, **Pending Backups**, **Memories**, **Reels**, **Saved Reels**, **Places**, **Quiz**, **Roulette**, **Wrapped**, **Folders**, and **History**.
  - Subnet LAN server discovery modal (`serverDiscovery.js`).

- 📥 **Library & Restore (`src/app/restore.tsx`)**:
  - Browse phone backup archives, server-shared folders (`/shared/list`), and public Google Drive folders in Server, Offline, or P2P mode.
  - Virtualized tree and grid view for lag-free expansion, sorting, and navigation across thousands of files.
  - Folder-level selection states (none / partial / all) and batch download restore engine with progress tracking.
  - In-app media player: Photo gallery, audio playback (`expo-audio`), and video streaming (`expo-video`) with on-demand range requests and video preview pre-warming.
  - **Device-to-Device Sharing Modal**: Select backed-up files, add a caption, and share them directly to chosen approved devices.
  - **Direct Post Creation**: Publish direct multi-media posts to the social feed with custom captions (`/share/direct-post/create`).
  - **Memory Quiz Cards**: Share photo trivia guessing cards to peer devices (`/share/quiz/create`).
  - **Comments & Reactions Sheet**: View media reactions and participate in threaded comments with deletion moderation.

- 🎬 **Short Video Reels (`src/app/reels.tsx`)**:
  - TikTok / Instagram Reels style vertical snap-scrolling video feed (`expo-video`).
  - Double-tap heart gesture and animated like toggle (`/media/{id}/react`).
  - Inline comment threads sheet.
  - Bookmark/save reels to personal collection (`/reels/save`).
  - Repost reels to peer device feeds (`/reels/repost`) with repost badge and counts.
  - Capture device author tags and video info overlay.

- 📰 **Shared Feed (`src/app/feed.tsx`)**:
  - Social media feed displaying photo and video albums, direct posts, and quiz cards shared across approved devices.
  - Multi-photo swipe carousel with active dot indicators and video playback badges.
  - Emoji reactions with live toggle states and counts.
  - Threaded comment section with real-time author tags and deletion rights.
  - Post management: Share target inspection, recipient addition/removal, caption editing, and post deletion by the owner.

- **Nearby Phone Sharing (Android native P2P)**:
  - Discover nearby Phone Backup installations on the same Wi-Fi using a UDP
    beacon and subnet probes; the embedded peer service listens on port `8088`
    by default and uses UDP port `8822` for discovery.
  - Pair mutually with a short verification PIN shown on both phones. P2P
    pairing is stored locally and is distinct from pairing with the backup
    server.
  - Send and receive direct media shares, feed posts, comments, and reactions
    over the local network. Received posts and peer metadata remain available
    on the phone; they do not automatically become server backups until the
    received media is included in a later sync.
  - This mode requires an Android native build, nearby phones on the same Wi-Fi
    network, and local-network access. It does not provide remote P2P over
    Tailscale/WireGuard.

- ⚙️ **Settings Screen (`src/app/settings.tsx`)**:
  - Server connection parameters (IP, Port, API Key, Device Token, Custom Username).
  - Background auto-sync interval selection (15m, 30m, 1h, 6h, 12h, 24h).
  - Wi-Fi only sync enforcement toggle.
  - Android CPU WakeLock toggle.
  - "Refresh All Backups" upload cache reset and prefetch utility (`/sync/upload-cache`).
  - Light & dark theme mode switcher.

---

### 📱 Dedicated Sub-Screens

- 🔖 **Saved Reels Collection (`src/app/saved-reels.tsx`)**:
  - Dedicated tabbed gallery for Saved Reels, Liked Reels, and Reposted Reels.
  - Video thumbnail grid with duration overlays and full-screen player mode with unsave actions.

- 📁 **Folder & File Type Configuration (`src/app/folders.tsx`)**:
  - Select device folders to back up via Android Storage Access Framework (SAF).
  - File type category filters (All, Photos, Videos, PDFs, Docs, Others).
  - Interactive swipe gestures: Swipe left to remove a folder from sync, swipe right to trigger an instant re-sync.
  - Pull-to-refresh for instant disk & configuration status check.

- 📜 **Sync History Screen (`src/app/history.tsx`)**:
  - Detailed session-by-session backup history list (duration, uploaded files, transfer size, timestamp, status).
  - Local and remote server history synchronization and clearing.

- 🧹 **Free Up Storage (`src/app/free-up.tsx` & `freeUpStorage.js`)**:
  - Scans local device directories to discover files that have been safely backed up to the server.
  - Hybrid verification using pre-fetched server upload cache (`/sync/upload-cache`) and server `/cleanup/candidates` check before allowing local file deletion.
  - Filter by category: All, Photos, Videos, Large Files, Older Files.
  - Safe local deletion with an offline sync queue that records deletions in `/cleanup/delete` when online.

- ⏳ **Pending Backups Viewer (`src/app/pending.tsx` & `pendingBackup.js`)**:
  - Incremental scanner showing newly created or modified files waiting for the next backup cycle.
  - Displays total pending size and file counts.
  - Selective manual upload for individual files or a batch "Upload All Pending" action.

---

### ✨ Memories & Interactive Story Suite

- 📖 **On This Day Stories (`src/app/memories.tsx`)**:
  - Story-style full-screen viewer for photos and videos captured on today's date in past years, plus a recent-days carousel.
  - Interactive controls: Tap to advance, press and hold to pause, swipe down to dismiss, and save media directly to device.
- ⚡ **Surprise Flashbacks**: Periodic unexpected photo memory cards served at randomized intervals.
- 🎬 **Monthly Rewind Reels**: Automated video recap montages generated by the server with soundtrack accompaniment.
- 🗺️ **Places & Smart Trip Albums (`src/app/places.tsx`)**:
  - Geotagged photo map and geographic location cluster viewer.
  - Auto-curated **Trip Albums** generated from spatial-temporal clustering (gap < 36h, distance < 50km) with reverse-geocoded place names.
- 🏆 **Backup Streaks (`streak.js`)**: Daily backup streak tracking, milestone badges, and evening streak-risk notifications if a sync has not yet occurred.
- 🧠 **Memory Trivia Quiz (`src/app/quiz.tsx`)**: Interactive quiz testing your memory of dates, months, and locations of past photos, with exportable Quiz Cards.
- 🎲 **Photo Roulette (`src/app/roulette.tsx`)**: Random memory wheel spinner.
- 🎁 **Backup Wrapped (`src/app/wrapped.tsx`)**: Annual and periodic backup infographic recap.
- 📱 **Home Screen Widget (`widget.js`)**: Server configuration sync for companion Android widgets.

---

## Native Architecture & Background Engine

- **Foreground Service Loop (`backgroundTask.js`)**: Uses `react-native-background-actions` for scheduled differential syncs while the app is minimized. Android battery and background-execution policy can defer work; the service does not guarantee every scheduled run executes immediately.
- **Android CPU WakeLock (`wakeLock.js`)**: Prevents CPU throttling or Wi-Fi radio sleep during active bulk uploads.
- **Single Live Notification & Unseen Badge Tracking (`notificationService.js`)**: Real-time batch progress updates via `expo-notifications` without sending individual per-file notifications; handles pending notification tracking (`/notifications/pending`, `/notifications/seen`) and deep links for Memories, Flashbacks, Streak Risks, Rewind Reels, and Shared Posts.
- **Differential Backup Engine (`uploader.js`, `scanner.js` & `crypto.js`)**: Walks Android media storage, generates relative paths & modified timestamps, hashes file contents (pure-JS SHA-256), pre-fetches server upload cache (`/sync/upload-cache`), and sends payload to `/files/check` before transferring missing files via `/upload` or `/upload/raw`.
- **Reels & Social API Client (`downloader.js`)**: Wraps `/files/*`, `/shared/*`, `/memories/*`, `/trips/*`, `/share/*`, `/reels/*`, `/comments/*`, and `/notifications/*` endpoints — file listing, ranged preview URLs, downloads, thumbnails, reactions, comments, reels reposting/saving, direct post creation, and feed fetching.
- **Storage Cleaner Engine (`freeUpStorage.js`)**: Coordinates hybrid backup verification (upload cache + candidate endpoints) and maintains an offline deletion queue with server sync.
- **Pending Files Engine (`pendingBackup.js`)**: Lightweight incremental scanner and snapshot cache for unbacked files.
- **Nearby peer stack (`p2pDiscovery.js`, `p2pClient.js`, `p2pServer.js`, `p2pSettings.js`)**: Local Wi-Fi discovery, mutual PIN pairing, peer authentication, direct media transfer, and an on-device feed backed by a native Android HTTP service.
- **Dynamic Theming System (`use-app-theme.tsx` & `theme.ts`)**: System-aware and user-configurable light/dark theme palettes with animated icon transitions.

---

## Development Setup

The app uses Expo SDK 57, React Native 0.86, and React 19. Use Node.js 22.13
or newer from the current LTS line, Android Studio/Android SDK, and JDK 17 for
local Android builds. See the [Expo SDK 57 reference](https://docs.expo.dev/versions/v57.0.0/) for the SDK toolchain.

### 1. Install Dependencies
```bash
npm ci
```

### 2. Start Development Server
```bash
npm run start
```

### 3. Build Native Android Development Client / APK
Note: The app requires native Android modules for background sync and P2P
sharing. Standard Expo Go does not include those native modules. Build a
Development Client or APK:

```bash
# Build development build via EAS
eas build --profile development --platform android

# Or build standalone Preview APK
npm run build:apk
# or
eas build --profile preview --platform android

# Or build standalone Production APK
npm run build:apk:prod
```

---

## Scripts

- `npm run version:sync`: Synchronizes package metadata with the Git release tag
- `npm start`: Synchronizes the version then runs `expo start`
- `npm run android`: Synchronizes the version then runs `expo run:android`
- `npm run ios`: Synchronizes the version then runs `expo run:ios`
- `npm run web`: Synchronizes the version then runs `expo start --web`
- `npm run lint`: Runs `expo lint`
- `npm run build:apk`: Synchronizes the version then builds a preview APK via EAS
- `npm run build:apk:prod`: Synchronizes the version then builds a production APK via EAS

For server installation, pairing, and deployment guidance, see the root
[setup guide](../../SETUP.md).

The native P2P server and UDP discovery are Android-only. EAS configuration
contains an iOS bundle identifier and an `ios` script, but that does not imply
feature parity: the P2P server is unavailable on iOS.
