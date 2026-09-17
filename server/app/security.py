"""Opaque bearer tokens: 256+ bits entropy, only digests persist server-side."""

import base64
import hashlib
import hmac
import secrets

SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 3
SCRYPT_MAXMEM = 64 * 1024 * 1024


def _derive(password: str, salt: bytes, *, legacy: bool = False) -> bytes:
    return hashlib.scrypt(
        password.encode(),
        salt=salt,
        n=2**14 if legacy else SCRYPT_N,
        r=SCRYPT_R,
        p=1 if legacy else SCRYPT_P,
        maxmem=SCRYPT_MAXMEM,
    )


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def token() -> str:
    return secrets.token_urlsafe(48)


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    value = _derive(password, salt)
    return "scrypt$32768$8$3$" + base64.urlsafe_b64encode(salt + value).decode()


def needs_rehash(encoded: str) -> bool:
    return not encoded.startswith("scrypt$32768$8$3$")


def verify_password(password: str, encoded: str) -> bool:
    try:
        legacy = needs_rehash(encoded)
        # Parameters are deliberately not accepted from storage: corrupted hashes
        # must never select unbounded CPU or memory costs.
        raw = base64.b64decode(
            encoded if legacy else encoded.split("$")[-1], altchars=b"-_", validate=True
        )
        if len(raw) != 80:
            return False
        value = _derive(password, raw[:16], legacy=legacy)
        return hmac.compare_digest(raw[16:], value)
    except (ValueError, TypeError):
        return False


# Unknown accounts perform the same current-cost verification as known accounts.
DUMMY_PASSWORD_HASH = hash_password(secrets.token_urlsafe(32))
