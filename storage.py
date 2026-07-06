import os
import re
from config import BACKUP_ROOT


def sanitize_relative_path(relative_path):
    parts = relative_path.split("/")
    parts = [re.sub(r'[<>:"|?*]', "_", p) for p in parts]
    return os.path.join(*parts)


def save_file(relative_path, content):
    safe_path = sanitize_relative_path(relative_path)
    full_path = os.path.join(BACKUP_ROOT, safe_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "wb") as f:
        f.write(content)
    return full_path