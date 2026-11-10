"""Quick sanity test for all admin API endpoints."""
import sys, asyncio, json
sys.stdout.reconfigure(encoding="utf-8")

from api.v1.admin import (
    list_admin_devices, list_admin_posts, list_admin_shared_folders,
    get_admin_status
)
from core.config import load_config

async def main():
    cfg = load_config()
    key = cfg.get("API_KEY", "")
    print(f"API key length: {len(key)}")

    # Status
    st = await get_admin_status(token=key)
    print(f"\n[STATUS]")
    print(f"  Total devices: {st['total_devices']}")
    print(f"  Total files:   {st['total_files']}")
    print(f"  Backup root:   {st['backup_root']}")

    # Devices
    devs = await list_admin_devices(token=key)
    print(f"\n[DEVICES] Count: {len(devs['devices'])}")
    if devs["devices"]:
        d = devs["devices"][0]
        print(f"  Sample: {d['display_name']!r}  folder={d['backup_folder']!r}")

    # Posts
    posts = await list_admin_posts(token=key)
    print(f"\n[POSTS] Total: {posts['total']}, page items: {len(posts['posts'])}")
    if posts["posts"]:
        p = posts["posts"][0]
        print(f"  Sample group_id: {p['group_id']!r}")
        print(f"  Caption: {(p['caption'] or '')[:60]!r}")
        print(f"  Items: {p['item_count']}, Targets: {p['target_names']}")

    # Shared folders
    sf = await list_admin_shared_folders(token=key)
    print(f"\n[SHARED FOLDERS] Count: {len(sf['shared_dirs'])}")
    for s in sf["shared_dirs"]:
        print(f"  id={s['id']!r}  label={s.get('label','')!r}  path={s['path']!r}")

    print("\n=== ALL CHECKS PASSED ===")

asyncio.run(main())
