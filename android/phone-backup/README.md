# Phone Backup - Android Client (v3.1.0)

React Native & Expo client app for the **Phone Backup Server**. Built with Expo SDK 57, React Native 0.86, TypeScript, and Expo Router.

---

## Features & App Structure

- 📊 **Dashboard Screen (`src/app/index.tsx`)**:
  - Live progress ring displaying backup state.
  - Quick action buttons (Manual Sync, Server Discovery, Pairing).
  - Storage statistics cards (Backed-up files count, transferred bytes, server connection state).
  - Fast LAN server discovery modal (`serverDiscovery.js`).

- 📥 **Restore & Download Screen (`src/app/restore.tsx`)**:
  - Browse all files backed up on the server for this device, or a shared PC directory (`/shared/list`).
  - The folder tree is flattened into a virtualized row list (instead of recursively mounting whole subtrees), so expanding, sorting, and scrolling stay smooth even with several thousand files.
  - Multi-select with folder-level checkboxes (none/partial/all state), long-press to enter selection mode, and a "Select All" action.
  - Directly restore files back into Android storage with progress updates.
  - In-app media previewer (Images, Videos via `expo-video`, Audio via `expo-audio`) with swipe navigation across all fetched files, and background warm-up of upcoming video previews for near-instant playback.

- ✨ **Memories Screen (`src/app/memories.tsx`)**:
  - "On This Day" story-style feed of photos and videos from past years, plus a scrollable row of recent days.
  - Full-screen story viewer with tap-to-advance, hold-to-pause, swipe-down-to-dismiss, and save-to-device.
  - Pulls from both phone backups and any shared PC folders tagged for this device.
  - Deep-linkable from the persistent Android notification when new memories are available.

- 📜 **Sync History Screen (`src/app/history.tsx`)**:
  - Session-by-session backup history list (Duration, files uploaded, bytes transferred, status).
  - Sync session history management and clearing.

- 📁 **Folder & Filter Configuration (`src/app/folders.tsx`)**:
  - Select device media folders to include/exclude.
  - File extension filters (Images, Videos, Audio, Documents, Custom extensions).

- ⚙️ **Settings Screen (`src/app/settings.tsx`)**:
  - Server connection settings (IP address, Port, API key, scoped Device Token).
  - Background auto-sync interval (15m, 30m, 1h, 6h, 12h, 24h).
  - Wi-Fi only sync enforcement toggle.
  - WakeLock execution toggle (`wakeLock.js`).

---

## Native Architecture & Background Engine

- **Foreground Service Loop (`backgroundTask.js`)**: Powered by `react-native-background-actions`, ensuring continuous timer-based differential syncs even when the app is minimized or the screen is turned off.
- **Android CPU WakeLock (`wakeLock.js`)**: Prevents CPU throttling or Wi-Fi radio sleep during active bulk uploads.
- **Single Live Notification (`notificationService.js`)**: Real-time batch progress updates via `expo-notifications` without sending individual per-file notifications; also surfaces and deep-links a daily Memories notification.
- **Differential Engine (`uploader.js`, `scanner.js` & `crypto.js`)**: Walks Android media storage, generates relative paths & modified timestamps, hashes file contents (pure-JS SHA-256), and sends the payload to `/files/check` before transferring missing files via `/upload` or `/upload/raw`.
- **Restore & Memories Client (`downloader.js`)**: Wraps `/files/*`, `/shared/*`, and `/memories/*` endpoints — file listing, ranged preview URLs, downloads, and video preview warm-up requests.

---

## Development Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Start Development Server
```bash
npx expo start
```

### 3. Build Native Android Development Client / APK
Note: The app requires native Android modules (`react-native-background-actions`, `expo-notifications`, `expo-network`) which are **not supported in standard Expo Go**. You must build a Development Client or APK:

```bash
# Build development build via EAS
eas build --profile development --platform android

# Or build standalone Preview APK
eas build --profile preview --platform android
```

---

## Scripts

- `npm start`: Runs `expo start`
- `npm run android`: Runs `expo run:android`
- `npm run lint`: Runs `expo lint`

