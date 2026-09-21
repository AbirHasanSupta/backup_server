"""Synchronize package/build metadata from the current Git release tag."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from version import get_version  # noqa: E402


def replace_version(path: Path, expected_replacements: int) -> None:
    content = path.read_text(encoding="utf-8")
    updated, replacements = re.subn(
        r'("version"\s*:\s*)"[^"]+"',
        rf'\g<1>"{get_version()}"',
        content,
        count=expected_replacements,
    )
    if replacements != expected_replacements:
        raise RuntimeError(f"Expected {expected_replacements} root version field(s) in {path}, found {replacements}.")
    path.write_text(updated, encoding="utf-8", newline="\n")


def main() -> None:
    version = get_version()
    if version == "0.0.0+unknown":
        raise RuntimeError("No semantic Git tag was found. Create a tag such as v4.5.0 before packaging a release.")
    (ROOT / "VERSION").write_text(f"{version}\n", encoding="utf-8", newline="\n")
    replace_version(ROOT / "android" / "phone-backup" / "package.json", expected_replacements=1)
    replace_version(ROOT / "android" / "phone-backup" / "package-lock.json", expected_replacements=2)
    print(f"Synchronized release version {version} from Git tag.")


if __name__ == "__main__":
    main()
