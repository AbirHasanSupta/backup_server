import sqlite3

conn = sqlite3.connect('backup.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()

tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]
print("Tables and counts:")
for t in tables:
    count = cur.execute(f"SELECT COUNT(*) FROM [{t}]").fetchone()[0]
    print(f"  {t}: {count} rows")

print("\n--- Column names for key tables ---")
for t in ["devices", "files", "media_index", "device_shares", "device_share_groups", "device_share_targets", "saved_reels", "sync_sessions", "trips", "trip_media", "reactions", "comments"]:
    if t in tables:
        cols = [r[1] for r in cur.execute(f"PRAGMA table_info([{t}])").fetchall()]
        print(f"{t}: {cols}")
