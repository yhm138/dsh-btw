"""Strip UTF-8 BOM from every shipped file, and fail loudly if one returns.

The maintainer's review of the marketplace PR found a BOM in `package.json`:
DSH's installer reads that file with `JSON.parse`, which rejects a BOM prefix, so
the plugin looked like it had no `dsh.bundle` at all. This script exists because
the mistake is easy to reintroduce — PowerShell's `Set-Content`/`Out-File` write
BOM by default on Windows.

Run it after editing files; it is also the guard used before every publish.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOM = b"\xef\xbb\xbf"
SKIP_DIRS = {".git", "node_modules"}


def iter_files():
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def main() -> int:
    fixed = []
    for path in iter_files():
        data = path.read_bytes()
        if data.startswith(BOM):
            path.write_bytes(data[len(BOM):])
            fixed.append(str(path.relative_to(ROOT)))

    remaining = [str(p.relative_to(ROOT)) for p in iter_files() if p.read_bytes().startswith(BOM)]

    # Every JSON shipped in the package must parse from raw bytes, exactly as DSH
    # reads it: no BOM tolerance, no encoding hint.
    import json

    bad = []
    for path in iter_files():
        if path.suffix != ".json":
            continue
        try:
            json.loads(path.read_bytes().decode("utf-8"))
        except Exception as error:  # noqa: BLE001 - report, do not crash
            bad.append(f"{path.relative_to(ROOT)}: {error}")

    print(f"stripped: {fixed if fixed else 'none'}")
    print(f"remaining BOM files: {remaining if remaining else 'none'}")
    print(f"json parse failures: {bad if bad else 'none'}")
    return 1 if (remaining or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
