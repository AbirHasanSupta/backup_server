# Phone Backup Server & Mobile Client — Architecture Progression & Handoff Guide

## 1. Executive Summary & Purpose
This document provides a current technical handover of the **Phone Backup Server** and its companion **React Native Android Mobile Client**. The implementation is a high-concurrency, modular, event-driven system with local or S3-compatible storage, resumable large-media upload, device-scoped authentication, and a production deployment template.

The latest local synthetic benchmark passed the 20-device/5-streamer SLA. It is a regression signal, not a substitute for real-device, network, or deployed-infrastructure acceptance testing.

---

## 2. Phase 1: Baseline Architecture & Pre-Existing Implementation

### 2.1 Initial Server Architecture
Originally, the backend was organized around root-level scripts:
- `server.py`: FastAPI server handling HTTP routes for media, auth, and pairing.
- `upload.py`: Handled multipart file uploads and single-item sync checking.
- `database.py`: Direct SQLite database helper containing table migrations and queries.
- `memories.py`, `rewind.py`, `trips.py`, `video_preview.py`: Standalone scripts for EXIF clustering, video transcoding, and memories.

### 2.2 Pre-Existing Pain Points & Bottlenecks
1. **$O(N)$ Full Table Scans on Ingestion**:
   - Every file upload triggered `COUNT(*)` and `SUM(size)` queries across the entire `files` table to compute device stats. Under 20 concurrent devices uploading thousands of photos, database latency degraded exponentially.
2. **SQLite Write-Lock Contention**:
   - Multiple separate write transactions occurred during upload ingestion (file insertion + device record touch), causing database lock timeouts (`database is locked`).
3. **Unthrottled Background Processing**:
   - Each uploaded photo or video spawned EXIF extraction, thumbnail generation, or clustering threads without debouncing, leading to OS thread exhaustion.
4. **Client-Side Polling & UI Thread Starvation**:
   - The React Native mobile client used 3-second interval polling (`getFeed()`, `listServerFiles()`) to refresh social posts and backup status.
   - Background upload workers ran at maximum network/CPU concurrency while the user scrolled through Reels, Social Feed, or Photo Galleries, causing dropped frames and UI stutter.

---

## 3. Phase 2: High-Concurrency Scaling & Modular Architecture Implementation

### 3.1 Layered Modular Backend Structure
The server was refactored into clean, isolated architectural layers:
```
backup_server/
├── api/
│   ├── deps.py                      # FastAPI dependency injection & auth guards
│   └── v1/                          # Versioned REST endpoints
│       ├── auth.py                  # Multi-IP discovery, token handshake, reinstall merge
│       ├── cleanup.py               # Storage management & deletion logging
│       ├── feed.py                  # Unified social feed & reactions
│       ├── files.py                 # File download, preview, and thumbnail streaming
│       ├── memories.py              # On-this-day memory queries
│       ├── reels.py                 # Bayesian scored reels & video discovery
│       ├── sync.py                  # Differential checking & chunked uploads
│       ├── trips.py                 # GPS trip clustering & smart albums
│       └── websockets.py            # Real-time WebSocket connection endpoints
├── core/
│   ├── config.py                    # Environment and app configuration
│   ├── exceptions.py                # Typed domain exceptions
│   ├── locks.py                     # Redis distributed locks + local fallback
│   └── security.py                  # Token generation, SHA256 validation, path guards
├── repositories/                    # Data access layer (pure SQL execution)
│   ├── base.py                      # Thread-local connection pool & execution helpers
│   ├── device_repo.py               # Device registration, O(1) stats touch, tokens
│   ├── file_repo.py                 # Batch checking, atomic insert, cleanup
│   ├── media_repo.py                # EXIF metadata & media indexing
│   ├── reels_repo.py                # Video quality rating, NLP tags, FNV-1a jitter
│   ├── social_repo.py               # Device shares, comments, reactions
│   └── trips_repo.py                # GPS bounding boxes, DBSCAN trip clustering
├── routers/
│   └── websocket_hub.py             # Room-based connection manager (/ws/{client_id}, /ws)
├── services/                        # Business logic layer
│   ├── feed_service.py              # Paginated feed aggregation & social grouping
│   ├── lock_service.py              # Lock orchestration for background tasks
│   ├── media_service.py             # Media query routing
│   ├── preview_service.py           # On-demand video preview generation
│   ├── redis_service.py             # Redis client wrapper with cached availability
│   ├── reels_service.py             # Bayesian reels ranking with seed jitter
│   ├── sync_service.py              # Differential file check & O(1) upload finishing
│   ├── thumbnail_service.py         # Thumbnail caching & HEIF/RAW decoding
│   ├── trips_service.py             # Smart album grouping & trip retrieval
│   └── ws_service.py                # Real-time event publisher (Redis pub/sub + in-memory)
├── storage/                         # Pluggable storage engine
│   ├── base.py                      # Abstract Base Class for storage providers
│   ├── local.py                     # Local disk backend with path traversal guards
│   ├── manager.py                   # Storage factory (`get_storage()`)
│   └── s3.py                        # S3/MinIO cloud object storage driver
├── tasks/                           # Background asynchronous task dispatchers
│   ├── indexing_tasks.py            # Trip clustering & EXIF indexing
│   ├── rewind_tasks.py              # Annual/monthly Rewind reel compilation
│   └── video_tasks.py               # FFmpeg video preview transcoding
├── tests/
│   ├── test_system_architecture.py  # 9-suite architecture regression suite
│   ├── test_multiuser_load.py       # 20-device concurrent synthetic benchmark
│   ├── test_resumable_storage.py    # Resume, checksum, isolation, expiry tests
│   ├── test_websocket_security.py   # Reject-before-accept socket auth test
│   └── test_api_contract.py         # Warning-free OpenAPI and secure-CORS tests
├── docker-compose.yml               # API, Celery, PostgreSQL, Redis, and Nginx topology
├── .env.example                     # Required deployment-secret template
└── .dockerignore                    # Keeps local state and Android build artifacts out of images
```

### 3.2 High-Throughput Database & Sync Optimizations
1. **Atomic Single-Transaction File Ingestion**:
   - Implemented `insert_file_and_touch_device()` in `database.py` and `repositories/file_repo.py`.
   - Combines file upsert, device timestamp update, and incremental counter increment (`files_backed_up = files_backed_up + 1`, `total_bytes = total_bytes + ?`) into a **single atomic SQLite transaction**.
   - Reduces database lock acquisitions by 50%, dropping p95 upload latency from ~64ms to **7.22ms**.
2. **Batch Differential Diff Check**:
   - `file_repo.batch_check_files()` processes 500+ items per query using SQL `IN (...)` parameter chunking.
   - 10,000 files across 20 concurrent devices are validated in **35.97ms p95**.
3. **Debounced Background Clustering**:
   - `trips.py` checks active debounce timers before spawning threads, eliminating redundant OS thread creation during high-frequency upload bursts.

### 3.3 Real-Time WebSocket Hub & Push Architecture
1. **WebSocket Gateway (`routers/websocket_hub.py`)**:
   - Supports targeted device rooms (`/ws/{client_id}`) and global broadcast channel (`/ws`).
   - Authenticates the room before accepting the socket; Android supplies its scoped device token (or the pairing API key) as an Authorization header.
   - Handles text/binary frame decoding, connection tracking, and 25s ping/pong keepalives.
2. **Event Emitter (`services/ws_service.py`)**:
   - Publishes real-time events: `file_uploaded`, `new_share`, `new_reaction`, `new_comment`, `preview_ready`, `rewind_ready`, `pairing_approved`, `sync_progress`.
   - Redis Pub/Sub backend with transparent in-memory fallback.
   - Redis availability check cached in `services/redis_service.py` to eliminate repeated import attempts.

---

## 4. Phase 3: React Native Android Mobile Client Integration

### 4.1 Real-Time WebSocket Client (`websocketClient.js`)
- Persistent WebSocket connection manager with exponential backoff reconnection.
- Sends the scoped device credential in a WebSocket Authorization header and does not place it in the connection URL.
- Dispatches server events directly to React Native screens via `DeviceEventEmitter`.
- Hooked into App lifecycle in `src/app/_layout.tsx` and pairing approval in `connectToServer.js`.

### 4.2 Dynamic UI Priority Mode
- Added `setUIPriorityMode(true / false)` to `backgroundTask.js` / `backgroundSync.js`.
- Automatically throttles background sync worker bandwidth, concurrency, and chunk size whenever the user enters active interactive screens:
  - `folders.tsx`, `quiz.tsx`, `places.tsx`, `wrapped.tsx`, `roulette.tsx`, `saved-reels.tsx`, `reels.tsx`, `restore.tsx`, `memories.tsx`.
- Yields upload work while interactive screens are active to protect scroll and playback responsiveness; verify target-device frame pacing during release acceptance.

### 4.3 Elimination of Polling in Social Feed
- `src/app/restore.tsx` subscribed to `feed_updated` and `social_updated` WebSocket events.
- Replaced 3-second polling interval with instant, event-driven UI updates.

### 4.4 Resumable Large-Media Upload
- Files at or above 64 MiB use 8 MiB pieces through `/upload/chunk`; smaller files retain native streaming/multipart uploads.
- A deterministic per-device upload ID lets the client request persisted chunk indexes after process death, roaming, or a network interruption.
- The server bounds chunk size/count, scopes temporary files per device, validates final size and SHA-256 before replacement, serializes completion retries, and removes abandoned sessions after the configured TTL.

---

## 5. Production Hardening Added After the Original Handoff

1. **Approved-device sync boundary**
   - All modular sync, upload, resumable-upload, upload-cache, and session routes now require both valid credentials and an accepted paired device ID. The global API key remains limited to enrollment and authorized administration flows.
2. **Browser boundary**
   - CORS now defaults to no browser origins and no credentials. Native Android networking is unaffected. Web deployments must set an explicit `CORS_ORIGINS` allowlist; credentials are enabled only when both that flag and at least one origin are configured.
3. **Configuration consistency**
   - `core.config` is a compatibility facade over `config.py`, so desktop/legacy and modular layers read one configuration source. Environment-owned deployment settings override persisted values for credential rotation.
4. **Deployment template**
   - Compose requires `API_KEY`, `POSTGRES_PASSWORD`, and `POSTGRES_URL` from `.env`, adds API/PostgreSQL/Redis health checks, persists app data, and does not publish an unconfigured TLS port. TLS must terminate at a configured external proxy/load balancer before public exposure.

---

## 6. Verification & Benchmark SLA Summary

### 6.1 System Architecture Test Suite (`tests/test_system_architecture.py`)
All 9 core architectural modules verified 100%:
- [x] **Distributed / Local Lock Service**: Concurrency isolation and timeout handling.
- [x] **Reels Bayesian Quality Scoring**: Prioritizes high-resolution, landscape, high-FPS video.
- [x] **FNV-1a Deterministic Seed Jitter**: Consistent yet shuffled discovery feeds.
- [x] **Reel Caption NLP Token Extraction**: Auto-tag extraction and keyword matching.
- [x] **Device Display Formatting**: Formats `username (device_name)`.
- [x] **Atomic O(1) Device Stats Touch**: Correct delta calculation without table scans.
- [x] **Storage Path Sanitization**: Path traversal and escape guard.
- [x] **Social Feed Service Pagination & Grouping**: Grouped device share cards.
- [x] **Trips Clustering Service**: DBSCAN geographical clustering.

### 6.2 Multi-User Synthetic Load Benchmark (`tests/test_multiuser_load.py`)
Simulates **20 concurrent mobile backup devices** + **5 concurrent feed streamers**:

| Metric | Measured Value | SLA Target | Status |
|---|---|---|---|
| **Differential Sync Checks (10,000 files)** | p50: **18.23ms** \| p95: **33.59ms** | < 50ms | **PASS** |
| **Check Error Rate** | **0.0%** (0 / 20 workers) | < 0.1% | **PASS** |
| **Atomic Upload Ingestion (1,000 files)** | p50: **0.16ms** \| p95: **7.72ms** | < 50ms | **PASS** |
| **Upload Error Rate** | **0.0%** (0 / 1,000 files) | 0.0% | **PASS** |
| **Unified Feed Query Latency (p95)** | **4.72ms** | < 50ms | **PASS** |
| **Reels Feed Query Latency (p95)** | **2.59ms** | < 50ms | **PASS** |
| **Data Integrity & Exact Counters** | **100% Match across all 20 devices** | 100% | **PASS** |
| **WebSocket Hub Room Isolation** | **100% Verified** | 100% | **PASS** |

### 6.3 Mobile App Build & Lint Verification
- **TypeScript Type Checking (`npx tsc --noEmit`)**: **0 Errors**.
- **ESLint (`npm run lint` / `expo lint`)**: **0 Errors, 0 Warnings**.
- **Expo Doctor (`npx expo-doctor`)**: **21/21 checks passed**.
- **Python Compilation (`python -m compileall -q .`)**: **100% Clean across all `.py` files**.
- **Resumable storage, WebSocket security, sync-authorization, and API-contract regression tests**: **7/7 passed**.
- **API contract checks**: OpenAPI produces **252 documented HTTP paths without duplicate-operation warnings**; default browser CORS has no allowed origins or credentials.

---

## 7. Remaining Deployment and Product Work

When continuing work on this project, prioritize the following roadmap items:

### 7.1 Deployment Acceptance
- The Compose topology and health checks are implemented, but this workspace has no Docker CLI. Validate `docker compose --env-file .env config` and bring up the stack in the target environment before release.
- Run the SQLite-to-PostgreSQL migration only against a backed-up production database, then perform upload, restore, background-task, Redis, and Celery smoke tests against the deployed services.
- Build and install an Android EAS production artifact on supported physical devices. Lint/type/SDK diagnostics do not exercise SAF permission changes, foreground-service constraints, Wi-Fi roaming, or large-media memory behavior.

### 7.2 Cloud & Remote Storage Providers
- S3/MinIO/R2 support is wired through `storage/s3.py`, including sanitized object keys and checksum validation. Provision the `S3_*` environment credentials/bucket and verify the provider in its actual target account before selecting `STORAGE_BACKEND=s3`.

### 7.3 Enhanced Real-Time Social Features
- WebSocket transport and client event emission for typing/read receipts exist, but `restore.tsx` does not yet render or send those states from comment controls. Treat visible typing/read UX as a product feature still requiring a dedicated design and implementation pass.
