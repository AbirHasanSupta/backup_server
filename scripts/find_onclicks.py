import re

with open('web_admin/js/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

matches = re.findall(r'onclick="[^"]*\$\{[^"]*\}[^"]*"', text)
print(f"Found {len(matches)} inline template onclick handlers:")
for m in matches:
    print(" -", m)
