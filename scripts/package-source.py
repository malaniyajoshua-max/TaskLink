"""Create a source-only handoff, excluding databases, secrets and dependencies."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {"readme.md", "changelog.md", ".gitignore", ".gitattributes"}
ROOT_DIRS = {".github", "desktop", "server", "scripts", "docs", "contracts"}
SKIP_DIRS = {
    "node_modules",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".git",
    "data",
    "work",
    "release",
    "dist",
    "dist-electron",
    "test-results",
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".gnupg",
}
SECRET_SUFFIXES = {
    ".db",
    ".db3",
    ".sqlite",
    ".sqlite2",
    ".sqlite3",
    ".s3db",
    ".dump",
    ".bak",
    ".backup",
    ".dpapi",
    ".tlbackup",
    ".tlserver",
    ".pfx",
    ".p12",
    ".key",
    ".pem",
    ".der",
    ".jks",
    ".keystore",
    ".pyc",
}
SECRET_NAMES = {
    "credentials.bin",
    "storage-key.bin",
    "credentials.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "_netrc",
    ".pgpass",
    "pgpass.conf",
    ".my.cnf",
    ".htpasswd",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
}
DATABASE_SIDECARS = ("-wal", "-shm", "-journal")


def is_link_or_junction(path: Path) -> bool:
    """Do not traverse links, including Windows junctions without symlink flags."""
    return path.is_symlink() or path.is_junction()


def should_include_file(
    candidate: Path, root: Path = ROOT, destination: Path | None = None
) -> bool:
    """Select regular source files without reading their contents.

    Paths remain lexical until link checks finish: resolving a junction first
    would conceal that the file was reached through an external directory.
    """
    root = root.absolute()
    candidate = candidate.absolute()
    try:
        rel = candidate.relative_to(root)
    except ValueError:
        return False
    if not rel.parts or ".." in rel.parts or not candidate.is_file():
        return False
    if destination is not None and candidate == destination.absolute():
        return False
    if any(is_link_or_junction(path) for path in (candidate, *candidate.parents)):
        return False
    parts = tuple(part.casefold() for part in rel.parts)
    if parts[0] not in ROOT_DIRS and rel.as_posix().casefold() not in ROOT_FILES:
        return False
    if any(part in SKIP_DIRS or part.startswith(".env") for part in parts):
        return False
    # Check every suffix so backups such as account.sqlite3.gz are excluded too.
    if any(suffix.casefold() in SECRET_SUFFIXES for suffix in candidate.suffixes):
        return False
    name = candidate.name.casefold()
    if name in SECRET_NAMES or name.endswith(DATABASE_SIDECARS):
        return False
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    destination = args.output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    files = []
    candidates = []
    for directory, subdirs, names in os.walk(ROOT):
        subdirs[:] = [
            name
            for name in subdirs
            if name.casefold() not in SKIP_DIRS
            and not name.casefold().startswith(".env")
            and not is_link_or_junction(Path(directory) / name)
        ]
        candidates.extend(Path(directory) / name for name in names)
    for candidate in candidates:
        if should_include_file(candidate, ROOT, destination):
            files.append((candidate.relative_to(ROOT).as_posix(), candidate))
    manifest = []
    with zipfile.ZipFile(destination, "x", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, candidate in sorted(files):
            data = candidate.read_bytes()
            archive.writestr("TaskLink/" + name, data)
            manifest.append(
                {
                    "file": name,
                    "bytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        archive.writestr(
            "TaskLink/SOURCE_MANIFEST.json",
            json.dumps(manifest, ensure_ascii=False, indent=2),
        )
    with zipfile.ZipFile(destination) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Archive integrity check failed")
    print(
        json.dumps(
            {
                "archive": str(destination),
                "files": len(files),
                "bytes": destination.stat().st_size,
                "sha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
            }
        )
    )


if __name__ == "__main__":
    main()
