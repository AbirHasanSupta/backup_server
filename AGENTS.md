# Phone Backup Server — Project Guide for Agents

This is the single-file orientation document for this repository. Read this
before exploring individual modules. It describes what the project does, how
the pieces fit together, where the important code lives, how to run and test
it, and which invariants must not be broken.

For user-facing setup instructions see [`SETUP.md`](SETUP.md). For the long
architecture history and previously recorded benchmarks see
[`SYSTEM_ARCHITECTURE_HANDOFF.md`](SYSTEM_ARCHITECTURE_HANDOFF.md). For the
Android client details see
[`android/phone-backup/README.md`](android/phone-backup/README.md).

---

## 1. What this project is

A self-hosted **phone backup, restore, and social-media system** made of two
applications:

1. **Server (this repository root)** — a FastAPI backend with:
   - a Windows CustomTkinter desktop control center (`desktop_app.py`),
   - a zero-build browser admin console (`web_admin/`, served at `/admin`),
   - SQLite for single-PC installs, or PostgreSQL + Redis + Celery + Nginx for
     Docker/multi-user installs.
2. **Android client** (`android/phone-backup/`) — an Expo SDK 57 / React
   Native 0.86 / React 19 / TypeScript app using Expo Router. It scans phone
   folders, performs differential backup, restores files, and provides Reels,
   social feed, memories, trips, quiz, roulette, and wrapped experiences.

The server also supports **direct phone-to-phone (P2P) sharing** over local
Wi-Fi. P2P is implemented natively in the Android app and is independent of
server pairing and server backup.

**Core product capabilities**

- Device pairing with optional interactive approval and per-device tokens.
- Fast differential backup using metadata checks and a pre-fetched upload cache.
- Multipart, raw-stream, and resumable chunked uploads with SHA-256 checks.
- Restore/library browsing, shared desktop folders, and Google Drive folders.
- Device-to-device album sharing, direct posts, quiz cards, reactions, comments.
- Short-video Reels feed with Bayesian quality ranking and save/repost actions.
- On-this-day memories, flashbacks, wrapped stats, quizzes, roulette, places.
- EXIF/GPS media indexing, automatic trip clustering, reverse geocoding.
- Server-generated rewind montage videos and optimized video previews.
- Safe "Free Up Space" cleanup with server-side verification and audit logging.
- Real-time WebSocket events (uploads, shares, reactions, pairing, previews).

---

## 2. System at a glance

```text
Android app (Expo/React Native)
  ├─ scanner.js / crypto.js          scan + hash local files
  ├─ uploader.js                     differential check + uploads
  ├─ downloader.js                   restore/library/social API client
  ├─ backgroundTask.js               foreground auto-sync + WakeLock
  ├─ websocketClient.js              live events
  ├─ p2pServer/Client/Discovery.js   local phone-to-phone sharing
  └─ src/app/*.tsx                   Expo Router screens

                 HTTP / WebSocket (port 8000 by default)
                                │
                    ┌───────────▼───────────┐
                    │  Nginx (Docker only)  │
                    │  :80 and :8000        │
                    └───────┬───────┬───────┘
                            │       │
              app API role  │       │  sync API role
             feed/reels/    │       │  /upload*, /files/check,
             library/admin  │       │  /sync/*, /status
                            │       │
                    ┌───────▼───────▼───────┐
                    │ FastAPI (server.py)   │
                    │ api → services →      │
                    │ repositories →        │
                    │ database/storage      │
                    └───┬───────────┬───────┘
                        │           │
              SQLite or PostgreSQL  ├── local disk or S3-compatible storage
                                    ├── Redis (cache, pub/sub, locks)
                                    └── Celery queues (video, rewind, indexing)
```

The desktop application is a GUI wrapper that runs the same FastAPI app in an
in-process server thread and exposes controls for devices, posts, shared
folders, logs, sync history, cache management, and settings.

---

## 3. Deployment modes and service roles

| Mode | Entry point | Database | Optional extras |
|---|---|---|---|
| Windows desktop | `python desktop_app.py` | SQLite | FFmpeg, tray, autostart, TLS |
| Headless local | `python server.py` | SQLite | FFmpeg |
| Docker/multi-user | `docker compose up -d --build` | PostgreSQL | Redis, Celery, Nginx |

`SERVICE_ROLE` controls which routers a server process mounts:

| Role | Mounted API surface | Used by |
|---|---|---|
| `all` | health, status, auth, sync, files, feed, reels, memories, trips, cleanup, WebSockets, admin, legacy router | desktop / local monolith |
| `app` | health, status, auth, files, feed, reels, memories, trips, cleanup, WebSockets, admin, legacy router | Docker `api` |
| `sync` | health, status, sync only | Docker `sync_api` |

Router assembly is in `api/v1/__init__.py`. Role validation is
`normalize_service_role()`; unknown roles fall back to `all`.

Docker splits traffic in `nginx/nginx.conf`:

- `/upload*`, `/files/check`, `/sync/*`, `/status*` → `sync_api`
- everything else, including `/ws/`, `/admin`, video previews → `api`
- Nginx publishes host ports **80** and **8000** (the Android discovery default).

The app services intentionally have no fixed `container_name`, so they can be
scaled with `--scale api=N --scale sync_api=N`. PostgreSQL connection budgets
must be recalculated when scaling.

---

## 4. Commands cheat sheet

### Server

```powershell
# Install desktop/dev dependencies
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

# Run the desktop control center (recommended on Windows)
python desktop_app.py

# Run the headless API
python server.py

# Build a standalone Windows executable
python build.py
# or
build.bat
```

`requirements.txt` is the desktop development set. `requirements-server.txt`
is the headless/container set (adds PostgreSQL, Redis, Celery, boto3, gunicorn).

### Docker

```powershell
Copy-Item .env.example .env
# edit .env: API_KEY, POSTGRES_PASSWORD, POSTGRES_URL, ADVERTISED_IPS, ...
python scripts/sync_version.py
docker compose up -d --build

# First migration from an existing SQLite install
python scripts/migrate_sqlite_to_postgres.py --merge-both
```

Set `ADVERTISED_IPS` to the host's real LAN IPv4 address. Containers cannot
discover the host Wi-Fi/LAN IP themselves; container bridge addresses are not
reachable from phones. `ADVERTISED_PORT` defaults to `8000`.

### Android

```powershell
cd android/phone-backup
npm ci
npm run start              # Expo dev server
npm run android            # local native build
npm run lint               # expo lint
npx tsc --noEmit           # type check
npx expo-doctor            # environment health

npm run build:apk          # EAS preview APK
npm run build:apk:prod     # EAS production APK
```

Native background-service and P2P modules require a development build or APK;
standard Expo Go does not include them.

### Tests and diagnostics

```powershell
# Discover and run unittest-based suites
python -m unittest discover -s tests -v

# Standalone architecture checks (plain functions, not unittest discovery)
python tests/test_system_architecture.py

# Synthetic 20-device + 5-streamer benchmark (prints pass/fail)
python tests/test_multiuser_load.py

# Admin endpoint sanity checks and real-HTTP smoke test
python scripts/sanity_check.py
python scripts/test_http.py

# Verify web admin JS references and inline handler safety
python scripts/verify_app.py
python scripts/check_ids.py
```

Benchmark numbers in `SYSTEM_ARCHITECTURE_HANDOFF.md` are historical regression
signals, not fresh evidence. Re-run the commands above before quoting them.

---

## 5. Repository map

```text
.
├── server.py                 FastAPI app factory, lifespan, CORS, role routing, thread pool
├── desktop_app.py            CustomTkinter control center; runs server in a thread
├── celery_app.py             Celery configuration and queue routing
├── config.py                 Authoritative config loader/saver, defaults, env overrides
├── database.py               SQLite schema, migrations, connection pools, legacy queries
├── database_pg.py            PostgreSQL schema init, connection pool, advisory lock
├── state.py                  In-process activity/log/approval state (+ Redis mirror)
├── storage.py                Legacy disk path helpers, per-device backup roots, SHA-256
├── upload.py                 Legacy compatibility router and historical transfer handlers
├── memories.py               Daily EXIF/GPS indexing, memories, flashback, wrapped, quiz
├── trips.py                  Spatial-temporal clustering, reverse geocoding, trip albums
├── rewind.py                 Server-side rewind montage generation with FFmpeg/music
├── video_preview.py          Range-streaming preview cache + background transcoding
├── thumbnail.py              Cached image/video thumbnails
├── ffmpeg_utils.py           FFmpeg/ffprobe resolution and thread configuration
├── network_info.py           LAN IP discovery, client IP, Tailscale metadata, cert fingerprint
├── version.py                Version from nearest semantic Git tag / bundled VERSION
├── build.py / build.bat      PyInstaller build scripts
├── Dockerfile                Python 3.11 image + FFmpeg + Gunicorn/Uvicorn
├── docker-compose.yml        Nginx, api, sync_api, 3 Celery workers, PostgreSQL, Redis
├── nginx/nginx.conf          Path routing, WebSocket upgrade, static thumbnail cache
├── api/
│   ├── deps.py               Auth dependency and accepted-device guard
│   └── v1/                   Versioned REST routers (see §7)
├── core/
│   ├── config.py             Compatibility facade over root config.py
│   ├── security.py           Bearer extraction and timing-safe token validation
│   ├── locks.py              Redis distributed lock with local fallback
│   ├── path_utils.py         Cross-platform path normalization
│   ├── shared_folders.py     Device-tagged shared-folder filtering
│   ├── timeutil.py           App timezone, local day resolution, formatting
│   ├── google_drive.py       Public Drive folder listing/browse/download helpers
│   └── exceptions.py         Typed domain exceptions
├── repositories/             Data access layer (SQLite + PostgreSQL aware)
│   ├── base.py               SQL placeholder adaptation and execution helpers
│   ├── device_repo.py        Devices, tokens, usernames, stats, reinstall merge
│   ├── file_repo.py          Batch diff, atomic insert + counters, sessions, cleanup
│   ├── media_repo.py         EXIF/GPS index, memories, wrapped, scans
│   ├── social_repo.py        Shares, groups, targets, reactions, comments, notifications
│   ├── reels_repo.py         Library reels, saved/liked/reposted, telemetry
│   └── trips_repo.py         Trip rows, media links, geocode cache
├── services/                 Business logic layer
│   ├── sync_service.py       Differential checks, skip logic, upload finish
│   ├── feed_service.py       Unified feed aggregation and grouping
│   ├── reels_service.py      Ranking, seed jitter, caption token extraction
│   ├── media_service.py      Memories/flashback/wrapped/quiz/roulette/places facade
│   ├── preview_service.py    HTTP range streaming and preview resolution
│   ├── thumbnail_service.py  Thumbnail responses
│   ├── trips_service.py      Trip retrieval and clustering orchestration
│   ├── ws_service.py         Targeted/broadcast events, upload coalescing
│   ├── redis_service.py      Redis client, cache, pub/sub, availability memoization
│   ├── lock_service.py       Distributed lock manager
│   └── places_trips_cache.py Redis response cache for places/trips
├── routers/websocket_hub.py  Authenticated device-room WebSocket gateway
├── tasks/                    Celery task entry points
│   ├── video_tasks.py        Video preview transcoding
│   ├── rewind_tasks.py       Rewind render dispatch
│   └── indexing_tasks.py     Trip clustering/indexing dispatch
├── storage/                  Pluggable storage abstraction
│   ├── base.py               StorageBackend ABC
│   ├── local.py              Local disk backend with traversal guards
│   ├── s3.py                 S3/MinIO/R2 backend
│   └── manager.py            `get_storage()` singleton factory
├── web_admin/                Static admin SPA (HTML/CSS/JS, no build step)
├── tests/                    unittest suites + architecture/load scripts
├── scripts/                  Migration, version sync, diagnostics, HTTP smoke tests
├── android/phone-backup/     Expo Android client (see §12)
└── nginx/, assets/, VERSION
```

Runtime/generated directories that may appear in a working checkout:

```text
backup.db, backup_server.db      SQLite databases
server_config.json               persisted configuration (gitignored)
cert.pem, key.pem                generated TLS cert/key (gitignored)
video_preview_cache/             optimized video copies
thumbnail_cache/                 image/video thumbnails
rewind_cache/, music_cache/      generated rewind reels and music
upload_chunks/                   resumable upload staging (local backend)
shared_direct_posts/, shared_quiz_cards/, shared_rewind_reels/
build/, dist/                    PyInstaller artifacts
```

Do not commit `.env`, `server_config.json`, databases, certificates, or build
outputs. They are intentionally ignored.

---

## 6. Server architecture

### 6.1 Layering rules

The backend is layered as:

```text
api/v1/*            HTTP validation, auth, response shaping
    ↓
services/*          business logic and orchestration
    ↓
repositories/*      SQL execution, SQLite/PostgreSQL differences
    ↓
database.py / database_pg.py + storage/*
```

Rules to preserve:

- **Routers do not execute raw SQL.** Use a repository.
- **Repositories do not perform HTTP concerns.** No FastAPI imports.
- **Services hold cross-repository logic**, ranking, grouping, and side effects.
- **Storage goes through `storage.manager.get_storage()`**, not direct file
  writes, for new upload/media code.
- **SQLite schema changes go in `database.init_db()`; PostgreSQL changes go in
  `database_pg.init_pg_db()`.** There is no Alembic migration framework.
- `database.py` is still required for SQLite and for compatibility helpers even
  when PostgreSQL is active. Do not delete it just because a repo exists.

### 6.2 Application startup (`server.py`)

`create_app(role)`:

- creates `FastAPI` with `APP_VERSION`,
- adds `ProxyHeadersMiddleware` and CORS,
- mounts `build_v1_router(role)` at both `/` and `/api/v1`,
- for `all`/`app`, mounts the WebSocket hub, the legacy `upload.py` router
  (excluded from OpenAPI), the `/admin` static SPA, and `/` redirect,
- adds an `X-Service-Role` response header for routing smoke tests.

`lifespan()`:

- sizes the per-process AnyIO/thread pool from `API_THREADPOOL_WORKERS`,
- initializes SQLite only for non-PostgreSQL deployments,
- initializes PostgreSQL when `DATABASE_BACKEND=postgres`,
- warms Redis (optional; absence is fine),
- starts the daily media indexing thread for `all`/`app`,
- logs the Tailscale endpoint when available,
- runs an hourly expired-resumable-upload cleanup task for `all`/`sync`.

Default blocking-work pool: PostgreSQL ≈ `max(8, min(24, cpu*2))`, SQLite ≈
`max(16, min(48, cpu*3))`. Docker overrides these per container.

### 6.3 API surface

Routers are in `api/v1/` and are dual-mounted (registered paths and under
`/api/v1`). Many modules also register historical aliases such as `/connect`
and `/api/connect`. Prefer the canonical versioned path for new clients.

| Router | Responsibility | Key paths |
|---|---|---|
| `health.py` | Unauthenticated discovery | `/ping`, `/api/ping` |
| `auth.py` | Pairing, devices, usernames | `/connect`, `/devices`, `/devices/{id}/username` |
| `status.py` | Online/activity probes | `/status`, `/status/activity` |
| `sync.py` | Diff, uploads, resumable chunks, sessions, upload cache | `/files/check`, `/upload`, `/upload/raw`, `/upload/chunk*`, `/upload/complete`, `/sync/*` |
| `files.py` | Library/restore, previews, thumbnails, shared folders, Drive | `/files/*`, `/shared/{source_id}/*`, `/shared/google-drive/*` |
| `feed.py` | Social feed, shares, groups, reactions, comments, notifications | `/feed`, `/share/*`, `/media/{id}/*`, `/notifications/*` |
| `reels.py` | Reels feed, saved/liked/reposted, telemetry | `/reels*` |
| `memories.py` | On-this-day, flashback, wrapped, quiz, roulette, places, rewind | `/memories/*` |
| `trips.py` | Trip albums | `/trips*` |
| `cleanup.py` | Free-up-space verification/deletion audit | `/cleanup/*` |
| `websockets.py` | Re-export of `routers.websocket_hub.ws_router` | `/ws/{client_id}` |
| `admin.py` | Web admin/desktop control endpoints | `/api/admin/*`, `/api/config`, `/api/logs`, `/api/pending-connections`, `/api/sync/history` |

`upload.py` remains mounted as a legacy compatibility router for existing
desktop/mobile clients. It is large and duplicates many historical endpoints;
new work should go in `api/v1/`, not `upload.py`.

### 6.4 Authentication and device approval

- `/ping` is unauthenticated.
- Most other routes accept either:
  - `Authorization: Bearer <global API_KEY>`, or
  - a scoped per-device token (`devices.token`).
- Some media routes accept `?token=` because Android video/image players cannot
  always attach headers.
- Sync/upload routes additionally require an **accepted, known device ID**
  (`_require_accepted_device` in `api/v1/sync.py`).
- Pairing (`/connect`) may wait up to 30 seconds for the desktop approval popup
  when `REQUIRE_APPROVAL=true`. Reinstalls are detected by device name/model and
  merged into the new device ID.
- WebSocket auth happens **before** `accept()`; unauthenticated clients get
  close code `1008`. Tokens must be sent in the `Authorization` header, not the
  URL.
- CORS defaults to an empty origin allowlist. Native Android is unaffected.
  Browser deployments must set `CORS_ORIGINS`; credentials are enabled only
  when both `CORS_ALLOW_CREDENTIALS` and an origin are configured.

### 6.5 Sync and upload flow

1. Android prefetches `/sync/upload-cache` (a compact list of already-known
   files for that device).
2. Android scans selected folders and posts metadata to `/files/check` in
   batches. `file_repo.batch_check_files()` chunks SQL `IN` queries.
3. Server returns `present` / `missing` per item. Set `verify_disk=true` to also
   check that the file physically exists with the expected size.
4. Upload one of three ways:
   - `/upload` — multipart form upload,
   - `/upload/raw` — raw request-body stream with optional SHA-256,
   - `/upload/chunk` + `/upload/complete` — resumable upload for files ≥ 64 MiB
     (client chunk size 8 MiB).
5. Resumable uploads:
   - `upload_id` is deterministic per device/file/size on the client,
   - chunks are device-scoped and bounded by `MAX_UPLOAD_CHUNK_BYTES`,
   - the server reports received indexes via `GET /upload/chunk/{upload_id}`,
   - completion verifies declared size and SHA-256 before atomic publication,
   - abandoned sessions expire after `UPLOAD_SESSION_TTL_SECONDS` (24 h default).
6. Completion calls `file_repo.insert_file_and_touch_device()` — one atomic
   transaction updates the file row and increments device counters
   (`files_backed_up`, `total_bytes`) without scanning the whole table.
7. A `file_uploaded` event is coalesced (2 s) and published over WebSocket.
8. Trip clustering is debounced/triggered; a completed `/sync/session` also
   records the session summary.

### 6.6 Library, shared folders, and Google Drive

- Phone backups are browsed per device from `files` rows and resolved under
  `BACKUP_ROOT/<device folder>`.
- Desktop shared folders live in `server_config.json` under `SHARED_DIRS`.
  Each entry has an `id`, `label`, `path`, and optional `device_ids` tags
  (`"all"` or specific device IDs). `core/shared_folders.py` filters access and
  removes nested duplicates.
- Google Drive folders are public "anyone with the link" folders browsed via
  Drive API v3. The API key can be configured server-side
  (`GOOGLE_DRIVE_API_KEY`) and/or stored in the Android app for offline/P2P use.
  `core/google_drive.py` caches folder listings and verifies descendants.
- Video previews always start streaming immediately: cache hits serve the
  optimized MP4; cache misses stream the original with HTTP range support while
  a background FFmpeg job builds a compatible MP4. Already-compatible MP4-family
  files stay on their original path.
- Thumbnails are cached in `thumbnail_cache/`; video thumbnail generation is
  bounded by `THUMBNAIL_WORKERS` per process.

### 6.7 Social model

- `device_shares` is one media item in a share; `device_share_groups` groups
  multi-item posts/albums; `device_share_targets` is the delivery list.
- Reaction/comment rows are anchored on `media_id` (from `media_index`) and
  carry `scope` (`post` vs reel/library contexts).
- `feed_service.build_unified_feed()` merges received shares and the device's
  own sent shares, groups by `share_group_id`, and paginates.
- Reels exclude share kinds `reel_repost` and `reels_only` from the normal feed.
- Library reels are private catalogue entries (`is_library_reel=1`) with no
  delivery target, so they cannot leak into the incoming feed.
- Notifications are target rows with `seen`/`notified` flags; pending counts
  are read from `/notifications/pending`.

### 6.8 Memories, trips, and rewind

- `memories.py` runs a daily background scan (single leader via lock) over all
  device backups and tagged shared folders. It extracts:
  - EXIF capture time/GPS for images (Pillow + `pillow-heif` for HEIC/HEIF),
  - `ffprobe` creation time for videos,
  - filesystem time as a fallback.
- Indexed rows go to `media_index` with day/month/year buckets and optional GPS.
- SQLite and PostgreSQL use different column names (`capture_time`/`cap_lat`/
  `cap_lon`/`gps_checked` vs `cap_time`/`lat`/`lon`/`has_gps`). Repositories
  normalize the differences — account for both when writing queries.
- `trips.py` clusters on capture-time gap (< 36 h) and distance (< 50 km), with
  at least 5 items. Centroids are reverse-geocoded via Nominatim with a local
  `geocode_cache` and rate limiting.
- `media_index` and `trips` power `/memories/*`, `/trips/*`, places, quiz,
  roulette, wrapped, and rewind.
- `rewind.py` renders vertical 1080×1920 montages with FFmpeg, a stratified
  random sample, Ken Burns transitions, and a music library. Rendering can run
  in-process or via Celery (`tasks.rewind_tasks`).
- `memories.py` and `rewind.py` are imported by both API and legacy code, so
  avoid turning them into thin wrappers without checking all call sites.

### 6.9 Real-time events

- `routers/websocket_hub.py` keeps device rooms keyed by `client_id`.
- `services/ws_service.py` publishes to Redis channels:
  - `channel:{device_id}` for targeted events,
  - `channel:broadcast` for app-wide events.
- Without Redis, it falls back to in-process dispatch to connected sockets.
- Event names include `pairing_approved`, `sync_progress`, `file_uploaded`,
  `new_share`, `new_reaction`, `new_comment`, `preview_ready`, `rewind_ready`.
- Bulk upload events are coalesced to avoid waking app workers per file.
- Android sends a ~25 s heartbeat; the server handles JSON ping/typing/read
  actions.

---

## 7. Persistence and data model

### 7.1 Backend selection

`DATABASE_BACKEND` is `sqlite` (default) or `postgres`.

- SQLite uses thread-local pooled connections in `database.py`, WAL mode,
  30 s busy timeout, a separate read-only connection pool, and `foreign_keys=ON`.
- PostgreSQL uses a process-local `psycopg`/`psycopg2` pool in `database_pg.py`.
  Schema init takes a PostgreSQL advisory transaction lock so concurrent
  Gunicorn workers do not race the first DDL.
- **Important fallback behavior:** `repositories/base.py` catches PostgreSQL
  errors and silently falls back to SQLite for that query. In Docker this can
  mask a broken/nonexistent PostgreSQL connection. Watch logs for
  `PostgreSQL read/write failed ... falling back to SQLite`.
- PostgreSQL `files` is HASH-partitioned by `device_id` into 8 partitions.

### 7.2 Main tables

| Table | Purpose / notable columns |
|---|---|
| `devices` | `device_id` (UUID-like), name, model, IP, status (`accepted`/pending), first/last seen, `files_backed_up`, `total_bytes`, `folder_name`, `username`, `token` |
| `files` | One row per backed-up file: device, path, size, modified time, external ID (SAF URI), SHA-256, upload time, storage key |
| `sync_sessions` | Per-run sync history (scans, uploaded/skipped/errors, duration, status, uploaded list) |
| `media_index` | EXIF/ffprobe/GPS index for phone and shared sources; unique on source + path |
| `scan_dirs` | Directory mtimes to skip unchanged folders during indexing |
| `cleanup_log` | Phone-side deletions after verified backup (audit trail) |
| `trips` / `trip_media` | Auto-curated trip albums and their media links |
| `reactions` / `comments` | Social engagement, scoped by `media_id` + `scope` |
| `device_share_groups` / `device_shares` / `device_share_targets` | Social posts, items, recipients, seen flags |
| `saved_reels` | Per-device bookmarks |
| `reel_telemetry` | Watch time, completion, loops, skips |
| `geocode_cache` | Rounded lat/lon → place name |

Schema evolution is manual:

- SQLite: append `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE` logic in
  `database.init_db()`, and add indexes.
- PostgreSQL: update `database_pg.init_pg_db()` (and keep the sequence-reset map
  in sync for migrated rows).
- Data migration from SQLite to PostgreSQL is a separate script:
  `scripts/migrate_sqlite_to_postgres.py`. It maps historical column names;
  read its docstring before changing either schema.

### 7.3 Storage layout

- `BACKUP_ROOT` is the media root. Default is `D:\PhoneBackup` on Windows.
- Each device is stored under `BACKUP_ROOT/<folder_name>/...`; `folder_name`
  comes from the human-readable device name and is sanitized.
- `storage/local.py` is the default backend. It implements:
  - path sanitization and root-escape prevention,
  - atomic temp-file writes,
  - SHA-256 computation,
  - resumable chunk staging under `upload_chunks/`,
  - chunk assembly with final size/hash verification,
  - expiry cleanup.
- `storage/s3.py` is an S3-compatible provider (S3/MinIO/R2), selected with
  `STORAGE_BACKEND=s3`. The bundled Compose file does not wire S3 credentials;
  treat it as a separately configured deployment option.
- Legacy path helpers in `storage.py` (`resolve_backup_root`,
  `full_path_for`, `sanitize_relative_path`) are still used throughout the
  legacy modules. Keep their traversal guards intact.

---

## 8. Configuration

Authoritative module: `config.py`. `core/config.py` is a compatibility facade
that re-exports it, so modular and legacy code see one configuration source.

### 8.1 Config file and data directory

- Persisted config: `<APP_DATA_DIR>/server_config.json`.
- SQLite database: `<APP_DATA_DIR>/backup.db`.
- `APP_DATA_DIR` resolution:
  - `APP_DATA_DIR` env var, if set;
  - source checkout mode → repository root;
  - frozen executable → `%APPDATA%\PhoneBackupServer` on Windows, or
    `$XDG_DATA_HOME/PhoneBackupServer` (or `~/.local/share/...`) elsewhere.
- The loader caches by file mtime, merges defaults, applies environment
  overrides, and preserves `SERVER_ID`.
- Environment-owned deployment settings override persisted values. This
  prevents a stale volume from reverting rotated credentials.

### 8.2 Important config keys

| Key | Meaning |
|---|---|
| `API_KEY` | Global pairing/admin key |
| `BACKUP_ROOT` | Media storage root |
| `HOST`, `PORT` | Bind address and port |
| `REQUIRE_APPROVAL` | Show desktop approval prompt for new devices |
| `DATABASE_BACKEND` | `sqlite` or `postgres` |
| `POSTGRES_URL` | PostgreSQL DSN |
| `REDIS_URL` | Redis DSN |
| `CELERY_ENABLED` | Dispatch heavy work to Celery |
| `STORAGE_BACKEND` | `local` or `s3` |
| `SHARED_DIRS` | Desktop shared folder definitions and device tags |
| `GOOGLE_DRIVE_API_KEY` | Server-side Drive API key |
| `VIDEO_PREVIEW_CACHE_DIR`, `VIDEO_PREVIEW_CACHE_MAX_BYTES` | Preview cache location/LRU limit |
| `MAX_UPLOAD_CHUNK_BYTES`, `MAX_UPLOAD_CHUNKS`, `UPLOAD_SESSION_TTL_SECONDS` | Resumable upload bounds |
| `CORS_ORIGINS`, `CORS_ALLOW_CREDENTIALS` | Browser allowlist |
| `ADVERTISED_IPS`, `ADVERTISED_PORT` | Docker/LAN discovery values |
| `TAILSCALE_IPS`, `TAILSCALE_DNS_NAME` | Remote endpoint advertised by `/ping` |
| `DESKTOP_NAME` | Display name for desktop-originated posts |
| `THEME_MODE`, `START_WITH_WINDOWS`, `MINIMIZE_TO_TRAY` | Desktop UI behavior |

`_ENV_CONFIG_KEYS` in `config.py` lists env variables that override persisted
config. If you add a deployment-controlled setting, update both `_DEFAULTS` and
that map, plus `.env.example`/docs where relevant.

Docker tuning variables include `GUNICORN_WORKERS`, `SYNC_GUNICORN_WORKERS`,
`API_THREADPOOL_WORKERS`, `SYNC_API_THREADPOOL_WORKERS`, `THUMBNAIL_WORKERS`,
`PG_POOL_MIN_SIZE`, `PG_POOL_MAX_SIZE`, `CELERY_*_CONCURRENCY`,
`FFMPEG_THREADS`, `REWIND_SEGMENT_WORKERS`, PostgreSQL memory settings, and
`REDIS_MAXMEMORY`. Pool sizes are per process; budget them across Gunicorn
workers and Celery children.

---

## 9. Background work

### 9.1 In-process

- **Media indexing loop** (`memories.startup_scan_loop`): starts for `all`/`app`,
  runs an initial scan then daily; uses a distributed/local lock so only one
  process is the leader.
- **Resumable upload cleanup**: hourly loop in `all`/`sync`; removes sessions
  older than `UPLOAD_SESSION_TTL_SECONDS`.
- **Trip clustering debounce**: `trips.trigger_background_clustering()` avoids
  spawning redundant threads during upload bursts.
- **Video preview conversion**: bounded background worker; duplicate requests
  coalesce into one job.
- **Thumbnail generation**: semaphore-bounded per process.

### 9.2 Celery

`celery_app.py` routes:

| Queue | Tasks | Default concurrency |
|---|---|---|
| `transcode_video` | `tasks.video_tasks.*` | 2 |
| `render_rewind` | `tasks.rewind_tasks.*` | 1 |
| `indexing_queue` | `tasks.indexing_tasks.*` | 2 |

Notable settings: JSON serializer, timezone from `APP_TZ`/`TZ` (default
`Asia/Dhaka`), 10 min hard / 8 min soft limits, late acks, worker recycling
after 200 tasks, `result_expires=3600`.

`CELERY_ENABLED` controls whether API code dispatches to Celery; without it the
same operations run in-process/background threads where supported.

---

## 10. Android client

Location: `android/phone-backup/`.

Stack: Expo SDK 57, React Native 0.86, React 19, TypeScript, Expo Router,
Reanimated 4, expo-video, expo-audio, expo-image, AsyncStorage, native
background actions and P2P modules.

`android/phone-backup/AGENTS.md` contains an important instruction: read the
versioned Expo 57 docs at <https://docs.expo.dev/versions/v57.0.0/> before
writing code. Do not assume older Expo APIs.

### 10.1 Screens (`src/app/`)

| File | Purpose |
|---|---|
| `_layout.tsx` | 5-tab root layout, theme, notifications, WebSocket lifecycle, P2P init |
| `index.tsx` | Backup dashboard, progress ring, quick actions, device username |
| `restore.tsx` | Library/restore browser, previews, sharing, direct posts, quiz cards, comments |
| `feed.tsx` | Social feed tab wrapper |
| `reels.tsx` | Vertical short-video feed, likes, comments, save/repost |
| `saved-reels.tsx` | Saved / liked / reposted reel gallery |
| `settings.tsx` | Server connection, sync interval, WakeLock, upload cache, theme |
| `folders.tsx` | SAF folder and file-type selection |
| `history.tsx` | Sync session history |
| `free-up.tsx` | Safe local cleanup candidates |
| `pending.tsx` | Pending/unbacked file queue |
| `memories.tsx` | On-this-day stories, flashbacks, rewind playback |
| `places.tsx` | Geotagged clusters and trip albums |
| `quiz.tsx`, `roulette.tsx`, `wrapped.tsx` | Interactive memory experiences |

### 10.2 Root-level modules

| Module | Responsibility |
|---|---|
| `uploader.js` | Differential check, upload cache, multipart/raw/resumable upload, sync session post, connection checks |
| `downloader.js` | Large API client: restore/library/shared/Drive, previews, memories, trips, reels, social, notifications; includes caches and URL builders |
| `scanner.js` | Recursive SAF/storage scan and extension filtering |
| `crypto.js` | Pure-JS SHA-256 for differential hashing |
| `backgroundTask.js` | Foreground-service auto-sync, scheduling, WakeLock, UI-priority throttling |
| `settings.js` | AsyncStorage wrapper and all persisted keys/parsers |
| `serverDiscovery.js` | LAN subnet scan for the server |
| `connectToServer.js` | Pairing/token negotiation |
| `connectionMode.js` | Server-vs-P2P reachability and mode selection |
| `websocketClient.js` | Reconnect/backoff WebSocket client and event emitter |
| `notificationService.js` | Channels, taps, memories/flashback/streak/recap notifications |
| `syncHistory.js` | Local session log and server upload of history |
| `streak.js` | Daily backup streak and risk reminders |
| `freeUpStorage.js` | Candidate verification and offline deletion queue |
| `pendingBackup.js` | Incremental pending-file scanner/cache |
| `p2pServer.js`, `p2pClient.js`, `p2pDiscovery.js`, `p2pSettings.js` | Local phone-to-phone service, client, discovery, settings |
| `wakeLock.js`, `widget.js`, `version.js` | Native helpers |
| `plugins/withBackgroundActionsDataSync.js` | Expo config plugin for background actions |

### 10.3 Client behavior and invariants

- Server mode and P2P mode are mutually exclusive; `connectionMode.js` decides.
- Android sends its scoped device token in headers. For WebSocket it must use
  the `Authorization` header, not a token in the URL.
- Server connection modes: LAN discovery, saved Tailscale MagicDNS/IP, or
  manually entered WireGuard tunnel endpoint. Remote modes skip subnet scans.
- Large files (≥ 64 MiB) use 8 MiB resumable chunks with deterministic upload
  IDs, so interrupted uploads resume after process death/roaming.
- Interactive screens call `setUIPriorityMode(true)` to throttle background
  upload concurrency/bandwidth and protect scroll/playback responsiveness.
- Sync history is stored locally and posted to `/sync/session`.
- The app cache is intentionally layered (memory + AsyncStorage disk) in
  `downloader.js`; use the provided invalidators rather than reading keys
  directly.
- P2P defaults: TCP peer service on `8088`, UDP discovery on `8822`. P2P state
  is local to the phone and separate from server pairing. P2P does not work
  over Tailscale/WireGuard.
- Some comment/typing/read-receipt helper plumbing exists server/client-side,
  but visible typing/read UX is not fully implemented.

### 10.4 Android commands and release metadata

```powershell
npm ci
npm run start
npm run lint
npx tsc --noEmit
npx expo-doctor
npm run build:apk
```

Version rules:

- The release version comes from the nearest semantic Git tag (`vMAJOR.MINOR.PATCH`).
- Do not manually edit version strings.
- `npm run version:sync` (or any pre-script) runs
  `scripts/sync_version.py`, which updates `VERSION`, `package.json`, and
  `package-lock.json`.
- Android `versionCode` is derived as `major * 1,000,000 + minor * 1,000 + patch`.
- EAS archives omit `.git`, so synced package metadata must be committed before
  building.

---

## 11. Desktop app and web admin

### 11.1 Desktop control center (`desktop_app.py`)

The GUI runs the FastAPI server in an in-process thread and provides:

- dashboard/state controls (start/stop/restart), storage stats, LAN IPs, QR code;
- device list, approval queue, custom usernames, revoke;
- post composer (desktop → devices), post moderation and recipient management;
- shared desktop folder management with device tags;
- Google Drive key/folder management;
- settings (backup root, API key, port, TLS, theme, tray/autostart, cache);
- live colored logs, search, sync history, cache stats/cleanup;
- system tray minimization and optional Windows autostart;
- self-signed TLS certificate generation and SHA-256 fingerprint display.

When frozen, `config.py` migrates legacy config/DB files from beside the EXE
into `%APPDATA%\PhoneBackupServer`.

### 11.2 Web admin (`web_admin/`)

- Served by FastAPI at `/admin`; `/` redirects there.
- Static, zero-build HTML/CSS/JS (`index.html`, `js/api.js`, `js/app.js`,
  `js/ws.js`, `css/custom.css`).
- Login uses the server API key and keeps it client-side for admin requests.
- Uses `/api/admin/*` endpoints from `api/v1/admin.py`.
- `scripts/check_ids.py` verifies JS element IDs exist in the HTML;
  `scripts/verify_app.py` checks for unsafe inline `onclick` interpolation.

---

## 12. Testing and quality gates

`tests/` contains mostly `unittest` suites plus two standalone scripts.

| Test | Covers |
|---|---|
| `test_api_contract.py` | OpenAPI warnings/duplicate operations, secure default CORS |
| `test_service_role.py` | Role router isolation, nginx routing, Compose sync service |
| `test_sync_security.py` | Sync rejects missing/unapproved devices |
| `test_resumable_storage.py` | Device scoping, atomic assembly, checksum failure, expiry |
| `test_websocket_security.py` | Reject-before-accept socket auth |
| `test_ws_upload_coalesce.py` | Upload event coalescing/idempotent flush |
| `test_postgres_schema_init.py` | Advisory-lock-first schema init |
| `test_docker_discovery_and_sync.py` | Discovery advertisement, Tailscale env, sync session normalization, PG batch check |
| `test_device_merge.py` | Reinstall/device-ID merge safety |
| `test_ecosystem_endpoints.py` | Discovery, connect, devices, status, browse, shared, memories, trips, cleanup |
| `test_google_drive_reels.py` | Drive source defaults, online/offline reels, key endpoints |
| `test_shared_folders.py` | Nested shared-root filtering and device tags |
| `test_state_activity_redis.py` | Cross-process activity/log mirror, local fallback |
| `test_timeutil.py` | App timezone, local day, epoch conversion |
| `test_trip_media_migration.py` | Trip media linkage migration |
| `test_system_architecture.py` | Locks, ranking, tokens, atomic stats, path safety, feed, trips |
| `test_multiuser_load.py` | 20-device synthetic sync + feed/reels p95 + WebSocket isolation |

Expected gates before handing off server changes:

```powershell
python -m compileall -q .
python -m unittest discover -s tests -v
python tests/test_system_architecture.py
```

For Android changes:

```powershell
cd android/phone-backup
npx tsc --noEmit
npm run lint
npx expo-doctor
```

---

## 13. Build and release

### Windows executable

`build.py` / `build.bat` use PyInstaller one-file/windowed mode:

- run `scripts/sync_version.py` first (fails if no semantic Git tag),
- bundle FFmpeg/ffprobe binaries from the local WinGet installation,
- collect packages (`customtkinter`, `tkinterdnd2`, `api`, `core`, repositories,
  routers, services, storage, tasks),
- output `dist/Phone Backup Server.exe`.

`Phone Backup Server.spec` is generated and gitignored; edit `build.py` or
`build.bat`, not the spec.

### Docker

`Dockerfile` is Python 3.11-slim with FFmpeg, libheif, curl, tzdata, Gunicorn,
and Uvicorn workers. Compose services:

| Service | Role / purpose |
|---|---|
| `nginx` | ingress, path routing, WebSocket upgrade, thumbnail static cache |
| `api` | `SERVICE_ROLE=app`, higher CPU weight |
| `sync_api` | `SERVICE_ROLE=sync`, isolated upload/sync pool |
| `celery_worker_video` | `transcode_video` queue |
| `celery_worker_rewind` | `render_rewind` queue |
| `celery_worker_indexing` | `indexing_queue` |
| `postgres` | PostgreSQL 16, named volume |
| `redis` | Redis 7, AOF, noeviction, named volume |

Host bind mounts are shared by every container and the desktop app:
`BACKUP_ROOT` → `/backup_storage`, `APP_DATA_DIR` → `/app_data`, and the
optional `SHARED_DRIVE_G` → `/host_g`. Because the desktop SQLite DB and Docker
PostgreSQL can coexist in the same app-data folder, migrate before relying on
both for the same records.

### Versioning

- Release identity = nearest semantic Git tag reachable from HEAD.
- `version.py` reads env `PHONE_BACKUP_VERSION`, then git tags, then bundled
  `VERSION`.
- `scripts/sync_version.py` writes `VERSION` and syncs package metadata.
- Server API, OpenAPI, discovery, Android config, and release builds share it.

---

## 14. Invariants and change recipes

### Invariants

1. **Never log or commit secrets.** `.env`, `server_config.json`, TLS private
   keys, and databases are gitignored and may contain real credentials.
2. **Keep sync/upload authorization strict.** New sync/upload routes need both
   token validation and an accepted device ID.
3. **Keep path traversal protection.** Resolve media only through
   `storage.get_storage()` or the guarded legacy helpers.
4. **Do not put auth tokens in WebSocket URLs.** Use the Authorization header.
5. **Preserve HTTP range support** for media/preview endpoints.
6. **Keep device counters atomic.** Use
   `insert_file_and_touch_device()`/incremental updates; never reintroduce
   `COUNT(*)`/`SUM(size)` on the whole `files` table per upload.
7. **Keep SQLite and PostgreSQL schemas in sync** and update the migration
   script when column names differ.
8. **Keep the two deployment modes working.** Docker changes must not break
   desktop/SQLite and vice versa.
9. **Do not manually edit versions or generated `.spec` files.**
10. **Avoid new work in `upload.py`.** Add to `api/v1/` instead unless preserving
    a legacy client path.

### Adding a server endpoint

1. Add the route to the appropriate `api/v1/*.py` router (or create a new router
   and include it in `build_v1_router`).
2. Use `verify_api_key_or_device_token(...)`; add
   `_require_accepted_device(...)` for sync/upload routes.
3. Put SQL in `repositories/*`, business logic in `services/*` when non-trivial.
4. Use `storage.manager.get_storage()` for file access.
5. Add a regression test under `tests/`.
6. If the route must be proxied differently in Docker, update
   `nginx/nginx.conf` and `test_service_role.py`.

### Adding a table or column

1. SQLite: update `database.init_db()`.
2. PostgreSQL: update `database_pg.init_pg_db()` (and sequence reset map if the
   table has a serial ID).
3. Update `scripts/migrate_sqlite_to_postgres.py` mappings if names differ.
4. Add repository functions; keep SQLite `?` placeholders (the base layer
   adapts them to `%s` for PostgreSQL).
5. Add indexes for lookup paths used by feeds/lists.

### Adding config

1. Add the default to `_DEFAULTS` in `config.py`.
2. Add it to `_ENV_CONFIG_KEYS` if deployment/env should control it.
3. Update `.env.example`, Docker Compose, and this document where relevant.

### Adding an Android screen or API client call

1. Add the screen under `android/phone-backup/src/app/` (Expo Router file-based).
2. Register navigation/tab entry in `_layout.tsx` if it is a top-level tab.
3. Add API helpers to `downloader.js` (read paths) or `uploader.js` (writes),
   following the existing timeout/retry/cache conventions.
4. Reuse `settings.js` for persisted values; do not invent new AsyncStorage keys
   outside its `KEYS` map.
5. Run `npx tsc --noEmit`, `npm run lint`, and `npx expo-doctor`.

---

## 15. Known limitations and gotchas

- **Docker discovery:** `ADVERTISED_IPS` is required; container bridge IPs are
  useless to phones. Tailscale metadata must come from host env because the
  container has no Tailscale CLI.
- **S3 is not wired in Compose.** `storage/s3.py` exists, but the bundled
  compose file uses local bind mounts and passes no S3 credentials.
- **Silent PG fallback:** a broken PostgreSQL connection can fall back to SQLite
  per query. Check `repositories/base.py` logs during Docker debugging.
- **Schema drift is real.** SQLite and PostgreSQL column names differ in
  `media_index`, `sync_sessions`, `device_shares`, and `trips`; repositories and
  the migration script normalize them.
- **No migration framework.** Schema changes are hand-written idempotent DDL.
- **SQLite write contention** is managed with WAL, busy timeout, one atomic
  insert transaction, and separate read connections. Do not add long write
  transactions.
- **In-process background work** (media indexing, previews, thumbnails) can
  compete with API traffic. Docker uses role splitting, thread caps, CPU shares,
  and Celery queues to contain this.
- **Android native build required.** Expo Go cannot run background services or
  P2P. P2P is LAN-only and does not traverse Tailscale/WireGuard.
- **Historical benchmark numbers are stale.** `SYSTEM_ARCHITECTURE_HANDOFF.md`
  explicitly says to re-run them.
- **`upload.py` is a compatibility monster.** It is ~158 KB and imports a large
  slice of the app. Understand its call sites before modifying or removing.
- **`database.py` is still essential.** PostgreSQL deployments still import
  SQLite helpers through repositories; `database_pg.py` is schema/pool only.
- **The release version is git-derived.** A source copy without `.git` and
  without `VERSION` reports `0.0.0+unknown`; packaging then fails intentionally.

---

## 16. Where to read next

Depending on the task:

- **Setup/deployment:** `SETUP.md`, `.env.example`, `docker-compose.yml`,
  `nginx/nginx.conf`, `Dockerfile`.
- **Architecture history and performance context:**
  `SYSTEM_ARCHITECTURE_HANDOFF.md`.
- **API behavior:** `api/v1/*.py` plus the endpoint table in `README.md`.
- **Data:** `database.py`, `database_pg.py`, `repositories/*`.
- **Media pipeline:** `memories.py`, `trips.py`, `rewind.py`,
  `video_preview.py`, `thumbnail.py`, `ffmpeg_utils.py`.
- **Android:** `android/phone-backup/README.md`, `src/app/*.tsx`,
  `uploader.js`, `downloader.js`, `backgroundTask.js`, `connectionMode.js`.
- **Tests:** `tests/` and `scripts/`.
