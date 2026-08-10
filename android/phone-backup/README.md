# Phone Backup - Android Client (v2.2.0)

React Native & Expo client app for the **Phone Backup Server**. Built with Expo SDK 57, React Native 0.86, TypeScript, and Expo Router.

---

## Features & App Structure

- 📊 **Dashboard Screen (`src/app/index.tsx`)**:
  - Live progress ring displaying backup state.
  - Quick action buttons (Manual Sync, Server Discovery, Pairing).
  - Storage statistics cards (Backed-up files count, transferred bytes, server connection state).
  - Fast LAN server discovery modal (`serverDiscovery.js`).

- 📥 **Restore & Download Screen (`src/app/restore.tsx`)**:
  - Browse all files backed up on the server for this device.
  - Directly restore files back into Android storage with progress updates.
  - In-app media previewer (Images, Videos via `expo-video`, Audio via `expo-audio`).
  - Access Shared PC directories configured on the desktop server (`/shared/list`).

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
- **Single Live Notification (`notificationService.js`)**: Real-time batch progress updates via `expo-notifications` without sending individual per-file notifications.
- **Differential Engine (`uploader.js` & `scanner.js`)**: Walks Android media storage, generates relative paths & modified timestamps, and sends payload to `/files/check` before transferring missing files via `/upload` or `/upload/raw`.

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

