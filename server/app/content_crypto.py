"""Versioned content encryption. Keys never live in the database or application logs.

Windows local mode wraps the key with per-user DPAPI. Other deployments must inject
TASKLINK_DATA_KEY from a secret manager (32 random bytes, base64), including restores.
"""

import base64
import ctypes
from functools import lru_cache
import json
import os
from pathlib import Path
import tempfile
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import JSON, Text, String
from sqlalchemy.types import TypeDecorator


def dpapi(value: bytes, decrypt=False) -> bytes:
    if os.name != "nt":
        raise RuntimeError(
            "Configure TASKLINK_DATA_KEY using a secret manager on this OS"
        )
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_ubyte))]

    memory = ctypes.create_string_buffer(value)
    source = Blob(len(value), ctypes.cast(memory, ctypes.POINTER(ctypes.c_ubyte)))
    target = Blob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = [
        ctypes.POINTER(Blob),
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.POINTER(Blob),
    ]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    if not function(
        ctypes.byref(source), None, None, None, None, 1, ctypes.byref(target)
    ):
        raise RuntimeError("Windows secure storage is unavailable for this account")
    try:
        return ctypes.string_at(target.data, target.size)
    finally:
        kernel32.LocalFree(target.data)


@lru_cache(maxsize=1)
def data_key() -> bytes:
    configured = os.getenv("TASKLINK_DATA_KEY")
    if configured:
        try:
            key = base64.b64decode(configured, validate=True)
        except ValueError:
            raise RuntimeError(
                "TASKLINK_DATA_KEY must be base64-encoded random bytes"
            ) from None
    else:
        filename = Path(
            os.getenv(
                "TASKLINK_KEY_FILE",
                str(Path(__file__).resolve().parents[1] / "data" / "storage-key.dpapi"),
            )
        )
        filename.parent.mkdir(parents=True, exist_ok=True)
        if not filename.exists():
            wrapped = dpapi(os.urandom(32))
            fd, temporary = tempfile.mkstemp(
                dir=filename.parent, prefix="key-", suffix=".tmp"
            )
            try:
                with os.fdopen(fd, "wb") as output:
                    output.write(wrapped)
                    output.flush()
                    os.fsync(output.fileno())
                try:
                    os.link(
                        temporary, filename
                    )  # Atomic create, never overwrite another process's key.
                except FileExistsError:
                    pass
            finally:
                Path(temporary).unlink(missing_ok=True)
        key = dpapi(filename.read_bytes(), decrypt=True)
    if len(key) != 32:
        raise RuntimeError("Content encryption requires a 32-byte key")
    return key


def seal(value: str, scope: str) -> str:
    nonce = os.urandom(12)
    encrypted = AESGCM(data_key()).encrypt(
        nonce, value.encode(), ("tasklink:server:v1:" + scope).encode()
    )
    return "tl1:" + base64.b64encode(nonce + encrypted).decode()


def unseal(value: str, scope: str) -> str:
    try:
        if not value.startswith("tl1:"):
            raise ValueError()
        raw = base64.b64decode(value[4:], validate=True)
        return (
            AESGCM(data_key())
            .decrypt(raw[:12], raw[12:], ("tasklink:server:v1:" + scope).encode())
            .decode()
        )
    except Exception:
        raise RuntimeError(
            "Encrypted content failed integrity verification; original data was not changed"
        ) from None


class EncryptedJSON(TypeDecorator):
    impl = JSON
    cache_ok = True

    def __init__(self, scope: str):
        super().__init__()
        self.scope = scope

    def process_bind_param(self, value, dialect):
        return (
            seal(
                json.dumps(value, ensure_ascii=False, separators=(",", ":")), self.scope
            )
            if value is not None
            else None
        )

    def process_result_value(self, value, dialect):
        return json.loads(unseal(value, self.scope)) if value is not None else None


class EncryptedText(TypeDecorator):
    impl = Text
    cache_ok = True

    def __init__(self, scope: str, legacy_length: int | None = None):
        super().__init__()
        self.scope = scope
        self.legacy_length = legacy_length

    def load_dialect_impl(self, dialect):
        # SQLite VARCHAR has TEXT affinity and no length restriction. Keeping the
        # declared type avoids destructive rebuilds of referenced identity tables.
        if dialect.name == "sqlite" and self.legacy_length:
            return dialect.type_descriptor(String(self.legacy_length))
        return dialect.type_descriptor(Text())

    def process_bind_param(self, value, dialect):
        return seal(value, self.scope) if value is not None else None

    def process_result_value(self, value, dialect):
        return unseal(value, self.scope) if value is not None else None
