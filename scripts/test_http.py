import sys, os
sys.path.insert(0, os.path.abspath('.'))

import urllib.request
import json
import threading
import time
import uvicorn
from server import app
from config import load_config

cfg = load_config()
api_key = cfg.get("API_KEY", "YOUR_SECRET_KEY")

config = uvicorn.Config(app, host="127.0.0.1", port=8010, log_level="warning")
server = uvicorn.Server(config)
t = threading.Thread(target=server.run, daemon=True)
t.start()
time.sleep(2)

def test_get(url_path):
    url = f"http://127.0.0.1:8010{url_path}"
    headers = {"Authorization": f"Bearer {api_key}"}
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            print(f"SUCCESS {url_path}: status {resp.status}, keys: {list(data.keys())}")
            return data
    except urllib.error.HTTPError as err:
        print(f"ERROR {url_path}: {err.code} {err.reason} - {err.read().decode()}")
        return None

try:
    print("=== Testing HTTP Endpoints over real HTTP ===")
    test_get("/api/admin/status")
    test_get("/api/admin/devices")
    test_get("/api/admin/posts")
    test_get("/api/admin/shared-folders")
    test_get("/api/admin/cache/stats")
    test_get("/api/sync/history")
    test_get("/api/logs")
    test_get("/api/config")
    
    # Also test without /api/admin prefix (legacy endpoints)
    test_get("/api/devices")
    test_get("/api/shared/list")
    test_get("/api/feed?device_id=desktop-server")
finally:
    server.should_exit = True
