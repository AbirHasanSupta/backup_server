"""Check that all element IDs referenced in app.js exist in index.html."""
import sys, re
sys.stdout.reconfigure(encoding="utf-8")

with open("web_admin/js/app.js", "r", encoding="utf-8") as f:
    js = f.read()
with open("web_admin/index.html", "r", encoding="utf-8") as f:
    html = f.read()

ids_in_js = set(re.findall(r"el\('([^']+)'\)", js))
ids_in_html = set(re.findall(r'id="([^"]+)"', html))

missing = ids_in_js - ids_in_html
print(f"IDs referenced in JS: {len(ids_in_js)}")
print(f"IDs defined in HTML:  {len(ids_in_html)}")
print(f"\nMissing from HTML ({len(missing)}):")
for m in sorted(missing):
    print(f"  {m}")

if not missing:
    print("  (none — all good!)")
