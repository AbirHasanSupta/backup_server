"""Verify app.js has no dangerous inline onclick string interpolation."""
import sys
import re

sys.stdout.reconfigure(encoding="utf-8")

with open("web_admin/js/app.js", "r", encoding="utf-8") as f:
    lines = f.readlines()

print(f"Total lines: {len(lines)}")

# Check for onclick= that contains template literal ${...}
problems = []
for i, line in enumerate(lines):
    s = line.strip()
    # Look for onclick="..." or onclick='...' containing a template variable
    if "onclick=" in s and "${" in s:
        problems.append((i + 1, s[:120]))

if problems:
    print("PROBLEMS: onclick with template interpolation:")
    for ln, txt in problems:
        print(f"  Line {ln}: {txt}")
else:
    print("OK: No onclick attributes with template-literal interpolation found.")

# Count data-action usages
data_actions = [l.strip() for l in lines if "data-action=" in l.strip()]
print(f"\ndata-action usages: {len(data_actions)}")

# Show all onclick lines for manual inspection
onclick_lines = [(i+1, l.strip()[:120]) for i, l in enumerate(lines) if "onclick=" in l.strip()]
print(f"\nAll onclick= occurrences ({len(onclick_lines)}):")
for ln, txt in onclick_lines:
    print(f"  {ln}: {txt}")
