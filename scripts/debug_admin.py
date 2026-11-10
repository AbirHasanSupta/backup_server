import sys, os
sys.path.insert(0, os.path.abspath('.'))

import re
import json
import asyncio
from config import load_config
import database as db

with open('web_admin/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

print('=== API Calls in web_admin/js/app.js ===')
matches = re.findall(r'api\.(get|post|postForm|delete)\(([^,\)]+)', text)
for m in matches:
    print(f"{m[0]:10} {m[1].strip()}")

print('\n=== DB Devices ===')
devices = db.get_devices()
print(f"Total devices in DB: {len(devices)}")
for d in devices[:5]:
    print(" - Device:", d.get('device_id'), d.get('device_name'), d.get('username'), "files:", d.get('files_backed_up'))

print('\n=== DB Shares / Posts ===')
shares_desktop = db.get_device_shares_by_sharer('desktop-server')
print(f"Shares by 'desktop-server': {len(shares_desktop)}")

conn = db.get_read_conn()
all_shares = conn.execute("SELECT * FROM device_shares").fetchall()
print(f"Total shares in device_shares table: {len(all_shares)}")
all_groups = conn.execute("SELECT * FROM device_share_groups").fetchall()
print(f"Total groups in device_share_groups table: {len(all_groups)}")
if all_groups:
    print("Sample group row:", dict(all_groups[0]))
conn.close()

# Let's check shared_dirs in config
cfg = load_config()
print('\n=== Config SHARED_DIRS ===')
print(json.dumps(cfg.get('SHARED_DIRS', []), indent=2))
