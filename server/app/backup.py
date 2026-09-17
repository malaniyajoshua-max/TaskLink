"""Encrypted, portable SQLite server backups. No credentials or keys are printed.

Usage: python -m app.backup create --output FILE.tlserver
       python -m app.backup restore --input FILE.tlserver --database NEW.db --key-file NEW.dpapi
The passphrase is read interactively, never from a command-line argument.
"""

import argparse
import getpass
import hashlib
import os
from pathlib import Path
import sqlite3
import tempfile
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from .content_crypto import data_key, dpapi

MAGIC = b"TLSB0001"
CHUNK = 1024 * 1024
MAX_SIZE = 8 * 1024**3


def password_key(password: str, salt: bytes) -> bytes:
    if not 12 <= len(password) <= 256:
        raise ValueError("Backup passphrase must contain 12-256 characters")
    return hashlib.scrypt(
        password.encode(), salt=salt, n=32768, r=8, p=3, dklen=32, maxmem=64 * 1024**2
    )


def create_backup(database: Path, output: Path, password: str):
    database, output = database.resolve(strict=True), output.resolve()
    if output.exists():
        raise ValueError("Backup destination already exists")
    salt, nonce = os.urandom(16), os.urandom(12)
    key = password_key(password, salt)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="tasklink-backup-", dir=output.parent
    ) as directory:
        snapshot = Path(directory) / "encrypted-snapshot.db"
        source = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
        target = sqlite3.connect(snapshot)
        try:
            source.backup(target, pages=256)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("Source database failed integrity verification")
        finally:
            source.close()
            target.close()
        if snapshot.stat().st_size > MAX_SIZE:
            raise ValueError("Server backup is limited to 8 GiB")
        temporary = Path(directory) / "archive.tmp"
        header = MAGIC + salt + nonce
        cipher = Cipher(algorithms.AES(key), modes.GCM(nonce)).encryptor()
        cipher.authenticate_additional_data(header)
        with temporary.open("xb") as archive, snapshot.open("rb") as source:
            archive.write(header + bytes(16))
            archive.write(cipher.update(data_key()))
            while chunk := source.read(CHUNK):
                archive.write(cipher.update(chunk))
            archive.write(cipher.finalize())
            archive.seek(36)
            archive.write(cipher.tag)
            archive.flush()
            os.fsync(archive.fileno())
        os.link(temporary, output)  # Atomic, and refuses to overwrite existing files.


def restore_backup(archive: Path, database: Path, key_file: Path, password: str):
    archive, database, key_file = (
        archive.resolve(strict=True),
        database.resolve(),
        key_file.resolve(),
    )
    if database == key_file or database.exists() or key_file.exists():
        raise ValueError(
            "Restore requires two new destination paths; existing data is never overwritten"
        )
    if archive.stat().st_size > MAX_SIZE + 84:
        raise ValueError("Server backup is limited to 8 GiB")
    database.parent.mkdir(parents=True, exist_ok=True)
    key_file.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="tasklink-restore-", dir=database.parent
    ) as directory:
        snapshot = Path(directory) / "encrypted-snapshot.db"
        with archive.open("rb") as source:
            header = source.read(52)
            if len(header) != 52 or header[:8] != MAGIC:
                raise ValueError("Unsupported server backup format")
            key = password_key(password, header[8:24])
            cipher = Cipher(
                algorithms.AES(key), modes.GCM(header[24:36], header[36:52])
            ).decryptor()
            cipher.authenticate_additional_data(header[:36])
            account_key = None
            try:
                with snapshot.open("xb") as target:
                    while chunk := source.read(CHUNK):
                        content = cipher.update(chunk)
                        if account_key is None:
                            if len(content) < 32:
                                raise ValueError("Truncated backup")
                            account_key, content = content[:32], content[32:]
                        target.write(content)
                    target.write(cipher.finalize())
                    target.flush()
                    os.fsync(target.fileno())
            except Exception:
                raise ValueError(
                    "Wrong passphrase or damaged backup; no destination data was changed"
                ) from None
        db = sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)
        try:
            if (
                db.execute("PRAGMA integrity_check").fetchone()[0] != "ok"
                or db.execute("PRAGMA foreign_key_check").fetchall()
            ):
                raise ValueError("Restored database failed integrity verification")
            marker = db.execute(
                "SELECT value FROM content_key_check WHERE id=1"
            ).fetchone()[0]
            import base64

            raw = base64.b64decode(marker[4:], validate=True)
            if (
                AESGCM(account_key).decrypt(
                    raw[:12], raw[12:], b"tasklink:server:v1:key-check"
                )
                != b"TaskLink content key v1"
            ):
                raise ValueError("Restored database key does not match")
        finally:
            db.close()
        wrapped = dpapi(account_key)  # New Windows account/machine protection.
        # Persist the protected key first. If the second exclusive create fails,
        # remove only the key just created here, not any pre-existing file.
        with key_file.open("xb") as destination:
            destination.write(wrapped)
            destination.flush()
            os.fsync(destination.fileno())
        try:
            os.link(snapshot, database)
        except Exception:
            key_file.unlink()
            raise


def main():
    parser = argparse.ArgumentParser(
        description="Encrypted TaskLink SQLite server backup and restore"
    )
    modes = parser.add_subparsers(dest="mode", required=True)
    create = modes.add_parser("create")
    create.add_argument("--output", type=Path, required=True)
    restore = modes.add_parser("restore")
    restore.add_argument("--input", type=Path, required=True)
    restore.add_argument("--database", type=Path, required=True)
    restore.add_argument("--key-file", type=Path, required=True)
    args = parser.parse_args()
    password = getpass.getpass("Backup passphrase (12+ characters): ")
    if args.mode == "create":
        if password != getpass.getpass("Confirm passphrase: "):
            raise ValueError("Passphrases do not match")
        from .db import engine

        if engine.dialect.name != "sqlite":
            raise ValueError(
                "Use the PostgreSQL operator backup process with separately managed encryption keys"
            )
        create_backup(Path(engine.url.database), args.output, password)
    else:
        restore_backup(args.input, args.database, args.key_file, password)
    print(
        "Backup operation completed and verified. Keep the passphrase separate from the archive."
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError) as exc:
        raise SystemExit(str(exc)) from None
