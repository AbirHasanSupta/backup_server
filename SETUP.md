# Phone Backup Server setup and installation guide

This repository contains two applications that work together:

- **Server:** a Windows desktop control centre and a FastAPI server that stores
  backups, pairs devices, serves media, and runs indexing/rewind jobs.
- **Android client:** an Expo/React Native app in `android/phone-backup` that
  scans the phone, uploads files, restores media, and connects to the server.

It can run as a simple single-PC installation with SQLite, or as a container
stack with PostgreSQL, Redis, Celery workers, and Nginx.

## Choose an installation mode

| Use case | Start with | Database and services |
| --- | --- | --- |
| One Windows PC on a home LAN | Desktop application | SQLite, no Redis or Docker needed |
| A server without a GUI | Headless Python server | SQLite by default |
| Multi-user or always-on deployment | Docker Compose | PostgreSQL, Redis, Celery, Nginx |

For a first installation, use the desktop application. Do not run the desktop
application and `server.py` at the same time: both listen on the configured
port.

## 1. Get the source code

Install [Git](https://git-scm.com/downloads), then open PowerShell in the
directory where you keep projects:

```powershell
git clone https://github.com/AbirHasanSupta/backup_server.git
Set-Location backup_server
git submodule update --init --recursive
```

If the repository was provided by another means, make sure it is a Git checkout
rather than a copied source folder. Release versions are derived from Git tags.

## 2. Install prerequisites

### Windows server

1. Install Python 3.10 or newer from [python.org](https://www.python.org/downloads/windows/). Select **Add Python to PATH** during installation.
2. Install [FFmpeg](https://ffmpeg.org/download.html) and make both `ffmpeg`
   and `ffprobe` available on `PATH`. It is optional for basic uploads, but is
   required for reliable video metadata extraction, rewind generation, and
   optimized video previews.
3. Verify the tools in a new PowerShell window:

   ```powershell
   python --version
   ffmpeg -version
   ffprobe -version
   ```

### Android development or APK builds

1. Install Node.js 18 or newer (the current LTS version is a good choice).
2. Install Android Studio and its Android SDK if you will use `expo run:android`.
3. Install the EAS CLI if you will create cloud builds:

   ```powershell
   npm install --global eas-cli
   eas login
   ```

The Android app contains native background-service modules, so standard Expo Go
is not sufficient for testing those features. Use a development client or APK.

### Docker deployment

Install Docker Desktop, enable the WSL 2 backend on Windows, and verify:

```powershell
docker --version
docker compose version
```

## 3. Create the Python environment

From the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

If PowerShell blocks activation, use the current-user policy once, then open a
new terminal:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

`requirements.txt` is the desktop-development set. `requirements-server.txt`
is the headless/container set and additionally includes PostgreSQL, Redis,
Celery, and S3 support.

## 4. Start the Windows desktop server

With the virtual environment active:

```powershell
python desktop_app.py
```

On first run the application creates its local configuration and SQLite database.
Use the **Settings** screen to choose the backup directory, listening address,
port, API key, and optional shared folders. The default listener is all network
interfaces on port 8000; choose a backup path on a drive with enough free space.

Allow the application through Windows Defender Firewall only on trusted private
networks. Do not expose the server directly to the public internet. For remote
access, use Tailscale or WireGuard and connect the Android client to the private
tunnel address.

## 5. Start the headless server

For a Linux server or a no-GUI Windows installation, create and activate a
virtual environment as above, then install the server dependencies:

```powershell
python -m pip install -r requirements-server.txt
$env:API_KEY = 'replace-with-a-long-random-secret'
$env:BACKUP_ROOT = 'D:\PhoneBackup'
$env:APP_DATA_DIR = 'D:\PhoneBackupAppData'
python server.py
```

On Linux, the equivalent environment-variable syntax is:

```bash
export API_KEY='replace-with-a-long-random-secret'
export BACKUP_ROOT=/srv/phone-backup
export APP_DATA_DIR=/var/lib/phone-backup
python server.py
```

Important environment settings are:

| Variable | Purpose |
| --- | --- |
| `API_KEY` | Required long, private API key used by devices before pairing |
| `BACKUP_ROOT` | Directory containing backed-up device files |
| `APP_DATA_DIR` | Durable location for config, SQLite data, caches, and generated media |
| `HOST`, `PORT` | Listener address and port |
| `DATABASE_BACKEND` | `sqlite` (default) or `postgres` |
| `POSTGRES_URL` | PostgreSQL connection URL when the backend is `postgres` |
| `REDIS_URL`, `CELERY_ENABLED` | Enable Redis-backed caching/locks and Celery tasks |
| `CORS_ORIGINS` | Comma-separated allowlist for browser clients; leave empty for native-only use |

The server automatically initializes SQLite when configured for standalone
operation. When PostgreSQL initialization fails, it logs a warning and falls
back to SQLite; treat that as a deployment configuration issue rather than a
successful multi-user deployment.

## 6. Run the Docker deployment

The Compose deployment starts Nginx on port 80, the API, two Celery workers,
PostgreSQL, and Redis. Its Docker volumes retain the database, backups, caches,
and Redis state.

1. Copy the supplied environment template and replace every placeholder with a
   long random value. Percent-encode special characters in the PostgreSQL URL.

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

2. Generate the release metadata from the checked-out tag, then build and start
   the stack:

   ```powershell
   python scripts/sync_version.py
   docker compose up --build -d
   ```

3. Check that every service is healthy and follow logs when diagnosing startup:

   ```powershell
   docker compose ps
   docker compose logs --follow api
   ```

4. Stop the stack without deleting data:

   ```powershell
   docker compose down
   ```

Do not use `docker compose down --volumes` unless you intend to permanently
delete the PostgreSQL database, backups, and cached data.

The included Nginx configuration exposes HTTP only. Terminate TLS at a trusted
reverse proxy or load balancer before allowing access outside a private network.

## 7. Install and run the Android client

Open another terminal:

```powershell
Set-Location android/phone-backup
npm ci
npm run start
```

The start command synchronizes package metadata from the Git tag before Expo
launches. To run a local Android development build:

```powershell
npm run android
```

To create APKs with EAS:

```powershell
npm run build:apk
npm run build:apk:prod
```

EAS runs invoked directly (for example, `eas build --platform android`) still
receive the tagged app version through `app.config.js`; use the npm scripts when
you also want `package.json` and `package-lock.json` refreshed.

After installing the client:

1. Put the phone and server on the same trusted network, or connect both to the
   same Tailscale/WireGuard network.
2. Open **Settings** in the app and use LAN scanning or enter the server name/IP
   and port.
3. Choose **Connect & Register**.
4. Approve the pairing request in the desktop server's **Devices** tab.
5. Select backup folders and start a sync.

## 8. Verify the installation

Use a token or API key when calling protected routes. For a local standalone
server, replace the value below with your configured key:

```powershell
$headers = @{ Authorization = 'Bearer replace-with-your-api-key' }
Invoke-RestMethod -Headers $headers http://127.0.0.1:8000/ping
Invoke-RestMethod -Headers $headers http://127.0.0.1:8000/status
```

`/ping` returns the server version, which must match the latest reachable
semantic Git tag (without its optional `v` prefix). The same version appears in
the OpenAPI document and UDP LAN-discovery response.

Run the focused regression tests from the repository root:

```powershell
python -m unittest tests.test_api_contract tests.test_websocket_security tests.test_sync_security
```

## 9. Release versioning from Git tags

The Git tag is the only release-version source. Supported release tags use
Semantic Versioning: `vMAJOR.MINOR.PATCH` (for example, `v4.5.0`) or the same
tag without the leading `v`.

When the running server is a Git checkout, it resolves the nearest semantic tag
reachable from `HEAD` automatically. The Python API, OpenAPI schema, UDP
discovery response, desktop fallback, and rewind HTTP user agent all use that
shared value. Android's Expo configuration resolves the same tag when it is
evaluated and derives Android's numeric `versionCode` as
`major * 1,000,000 + minor * 1,000 + patch`.

Create a release by committing the release changes, tagging that commit, and
then rebuilding:

```powershell
git tag -a v4.5.0 -m 'Release v4.5.0'
git push origin v4.5.0
python scripts/sync_version.py
python build.py
```

`sync_version.py` writes the ignored `VERSION` file used inside a PyInstaller
binary and refreshes Android's package metadata. `build.py` runs it
automatically before packaging. Run it before `docker compose up --build` too,
because Docker build contexts intentionally exclude `.git`.

If a checkout has no release tag, source mode reports `0.0.0+unknown` and
release packaging stops with a clear error. This prevents accidentally shipping
an untagged build as a known release.

## 10. Project map and operations

| Location | Responsibility |
| --- | --- |
| `desktop_app.py` | Windows CustomTkinter control centre and embedded server launcher |
| `server.py` | FastAPI application, lifespan initialization, CORS, and headless runner |
| `api/v1/` | Current structured API routes; `upload.py` preserves legacy route compatibility |
| `database.py`, `database_pg.py` | SQLite and PostgreSQL persistence implementations |
| `storage/` | Local/S3 storage abstraction and resumable-upload chunk cleanup |
| `services/`, `repositories/`, `tasks/` | Modular business logic, database access, and Celery jobs |
| `memories.py`, `rewind.py`, `trips.py` | Media indexing, memory/reel generation, and location trip clustering |
| `docker-compose.yml`, `nginx/` | Production-oriented multi-service deployment |
| `android/phone-backup/` | Expo mobile client, custom native config plugin, and EAS configuration |

Back up the configured backup root and application-data directory (or the
Docker volumes) before upgrades. Test restoration of a small file periodically;
a backup is only useful if it can be restored.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Phone cannot discover the server | Confirm both devices are on the same subnet, server firewall permits the configured TCP/UDP port, and no second server process owns the port. Enter the server IP manually to isolate discovery. |
| Pairing is rejected or times out | Verify the API key, accept the desktop approval prompt within 30 seconds, and remove a stale device entry before re-pairing if necessary. |
| Videos have no preview or rewind fails | Run `ffmpeg -version` and `ffprobe -version` from the same terminal that starts the server. |
| Docker API stays unhealthy | Use `docker compose logs api postgres redis`; verify `.env` contains matching `POSTGRES_PASSWORD` and `POSTGRES_URL`. |
| App reports an unknown version | Run from a tagged Git checkout, or set `PHONE_BACKUP_VERSION` to a valid SemVer value for an intentional non-Git deployment. |
| Android build rejects a version code | Use a numeric three-part semantic tag with each component from 0 through 999, and ensure each new release tag produces a higher numeric code. |
