import os
from config import BACKUP_ROOT


def save_file(relative_path, content):
    full_path = os.path.join(BACKUP_ROOT, relative_path)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "wb") as f:
        f.write(content)
    return full_path
