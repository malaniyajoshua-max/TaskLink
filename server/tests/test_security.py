import base64
import hashlib
import json
import os
from uuid import uuid4
from sqlalchemy import text
from app.db import SessionLocal, engine
from app.models import User
from app.security import verify_password
from app.content_crypto import seal, unseal, dpapi
from app.http_security import MAX_BODY, rate_windows


def test_password_legacy_upgrade_and_rejection(client, accounts):
    account, _ = accounts("PasswordUpgrade")
    password, salt = "correct horse battery", os.urandom(16)
    legacy = base64.urlsafe_b64encode(
        salt + hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1)
    ).decode()
    with SessionLocal.begin() as db:
        db.get(User, account["user"]["id"]).password_hash = legacy
    response = client.post(
        "/api/v1/auth/login",
        json={"identifier": account["user"]["email"], "password": password},
    )
    assert response.status_code == 200
    with SessionLocal() as db:
        stored = db.get(User, account["user"]["id"]).password_hash
    assert stored.startswith("scrypt$32768$8$3$") and verify_password(password, stored)
    assert not verify_password("wrong", stored)
    assert not verify_password(password, "scrypt$1073741824$8$3$bad")
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"identifier": "missing@example.com", "password": password},
        ).status_code
        == 401
    )


def test_ingress_limits_apply_to_streams_and_early_errors(client):
    for headers, status, code in [
        ({"Host": "evil.example"}, 400, "invalid_host"),
        ({"Host": "evil@127.0.0.1"}, 400, "invalid_host"),
        ({"Host": "127.0.0.1/path"}, 400, "invalid_host"),
        ({"Host": "127.0.0.1:99999"}, 400, "invalid_host"),
        ({"Origin": "https://evil.example"}, 403, "origin_denied"),
        ({"Content-Length": str(MAX_BODY + 1)}, 413, "body_too_large"),
        ({"Content-Length": "-1"}, 400, "invalid_length"),
    ]:
        result = client.post("/api/v1/auth/login", headers=headers, content=b"{}")
        assert result.status_code == status and result.json()["code"] == code
        assert result.headers["cache-control"] == "no-store"
        assert result.headers["x-content-type-options"] == "nosniff"
    result = client.post(
        "/api/v1/auth/login",
        content=(b"x" * 65536 for _ in range(MAX_BODY // 65536 + 1)),
    )
    assert result.status_code == 413
    # A caller cannot select its rate-limit identity using proxy headers.
    rate_windows.clear()
    for index in range(60):
        result = client.post(
            "/api/v1/auth/refresh",
            headers={"X-Forwarded-For": f"10.0.0.{index}"},
            json={"refresh_token": "invalid-token-value"},
        )
    result = client.post(
        "/api/v1/auth/refresh", json={"refresh_token": "invalid-token-value"}
    )
    assert result.status_code == 429 and result.headers["retry-after"] == "60"


def test_content_is_encrypted_and_ciphertext_tampering_fails(client, accounts):
    account, headers = accounts("CipherAudit")
    marker = "private-task-body-" + os.urandom(16).hex()
    result = client.post(
        "/api/v1/sync/push",
        headers=headers,
        json={
            "operations": [
                {
                    "operation_id": str(uuid4()),
                    "entity_id": str(uuid4()),
                    "entity_type": "task",
                    "action": "upsert",
                    "base_version": 0,
                    "payload": {"title": marker},
                }
            ]
        },
    )
    assert (
        result.status_code == 200 and result.json()["results"][0]["status"] == "applied"
    ), result.text
    with engine.connect() as db:
        for table, column in [
            ("documents", "body"),
            ("changes", "payload"),
            ("operations", "result"),
        ]:
            stored = db.execute(text(f"SELECT {column} FROM {table}")).scalars().all()
            assert stored and all(marker not in str(item) for item in stored)
            assert all(json.loads(item).startswith("tl1:") for item in stored)
        name = db.execute(
            text("SELECT name FROM users WHERE id=:id"), {"id": account["user"]["id"]}
        ).scalar_one()
        assert name.startswith("tl1:") and "CipherAudit" not in name
    encrypted = seal(marker, "test")
    assert unseal(encrypted, "test") == marker
    import pytest

    with pytest.raises(RuntimeError):
        unseal(encrypted, "other-column")
    with pytest.raises(RuntimeError):
        unseal(encrypted[:-5] + "AAAAA", "test")
    if os.name == "nt":
        key = os.urandom(32)
        wrapped = dpapi(key)
        assert wrapped != key and dpapi(wrapped, decrypt=True) == key


def test_legacy_database_migration_preserves_references_and_erases_live_plaintext(
    tmp_path,
):
    import sqlite3
    import subprocess
    import sys
    import pytest
    from pathlib import Path

    server = Path(__file__).resolve().parents[1]
    filename = tmp_path / "legacy.db"
    environment = {
        **os.environ,
        "TASKLINK_DATABASE_URL": "sqlite:///" + filename.as_posix(),
    }
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "0001_initial"],
        cwd=server,
        env=environment,
        check=True,
        capture_output=True,
    )
    user, workspace, task = (str(uuid4()) for _ in range(3))
    secret = "legacy-sensitive-" + uuid4().hex
    body = json.dumps(
        {
            "title": secret,
            "description": secret * 100,
            "project_id": None,
            "parent_id": None,
        }
    )
    with sqlite3.connect(filename) as db:
        db.execute("PRAGMA foreign_keys=ON")
        db.execute(
            "INSERT INTO users VALUES(?,?,?,?)",
            (user, "migration@example.com", secret, "old-hash"),
        )
        db.execute(
            "INSERT INTO workspaces VALUES(?,?,?,?,?)",
            (workspace, secret, user, 1, False),
        )
        db.execute("INSERT INTO memberships VALUES(?,?,?)", (workspace, user, "owner"))
        db.execute(
            "INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)",
            (task, "task", user, workspace, body, 1, False, "2030-01-01T00:00:00.000Z"),
        )
    db.close()
    assert secret.encode() in filename.read_bytes()
    subprocess.run(
        [sys.executable, "-m", "app.migrate"],
        cwd=server,
        env=environment,
        check=True,
        capture_output=True,
    )
    with sqlite3.connect(filename) as db:
        assert not db.execute("PRAGMA foreign_key_check").fetchall()
        assert (
            db.execute("SELECT count(*) FROM documents WHERE id=?", (task,)).fetchone()[
                0
            ]
            == 1
        )
        value = json.loads(
            db.execute("SELECT body FROM documents WHERE id=?", (task,)).fetchone()[0]
        )
        assert json.loads(unseal(value, "documents.body"))["title"] == secret
        account_id = db.execute(
            "SELECT account_id FROM users WHERE id=?", (user,)
        ).fetchone()[0]
        assert account_id.startswith("TL-") and len(account_id) == 12
        with pytest.raises(sqlite3.IntegrityError):
            db.execute(
                """INSERT INTO users
                (id,email,name,password_hash,avatar,account_id)
                VALUES(?,?,?,?,?,?)""",
                (str(uuid4()), "null-account@example.com", "name", "hash", None, None),
            )
    assert secret.encode() not in filename.read_bytes()


def test_portable_server_backup_is_authenticated_and_preserves_database(
    client, accounts, tmp_path
):
    from pathlib import Path
    import sqlite3
    import pytest
    from app.backup import create_backup, restore_backup
    from app.content_crypto import data_key

    account, _ = accounts("ServerBackup")
    file, target, key_file = (
        tmp_path / "backup.tlserver",
        tmp_path / "restored.db",
        tmp_path / "restored.dpapi",
    )
    password = "separate server recovery passphrase"
    create_backup(Path(engine.url.database), file, password)
    assert account["user"]["email"].encode() not in file.read_bytes()
    with pytest.raises(ValueError):
        restore_backup(file, target, key_file, "wrong recovery passphrase")
    assert not target.exists() and not key_file.exists()
    restore_backup(file, target, key_file, password)
    assert dpapi(key_file.read_bytes(), decrypt=True) == data_key()
    db = sqlite3.connect(target)
    try:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert (
            db.execute(
                "SELECT email FROM users WHERE id=?", (account["user"]["id"],)
            ).fetchone()[0]
            == account["user"]["email"]
        )
    finally:
        db.close()
    with pytest.raises(ValueError):
        restore_backup(file, target, key_file, password)


def test_success_response_requires_committed_transaction(client, email_verification):
    import sqlite3
    from fastapi.testclient import TestClient
    from app.main import app

    email = "commit-order-" + uuid4().hex + "@example.com"
    verification = email_verification(email)
    failed_email = "failure-" + email
    failed_verification = email_verification(failed_email)
    observed = []

    async def observe(scope, receive, send):
        async def checked_send(message):
            if message["type"] == "http.response.start" and message["status"] == 201:
                db = sqlite3.connect(engine.url.database)
                try:
                    observed.append(
                        db.execute(
                            "SELECT count(*) FROM users WHERE email=?", (email,)
                        ).fetchone()[0]
                    )
                finally:
                    db.close()
            await send(message)

        await app(scope, receive, checked_send)

    with TestClient(observe, base_url="http://127.0.0.1") as connection:
        response = connection.post(
            "/api/v1/auth/register",
            json={
                "email": email,
                "name": "Commit verification",
                "password": "commit order validation password",
                **verification,
            },
        )
    assert response.status_code == 201
    assert observed == [
        1
    ], "Never acknowledge a login or sync before its database transaction commits"
    from sqlalchemy import event
    from sqlalchemy.orm import Session

    def fail_commit(session):
        raise RuntimeError("isolated commit failure")

    event.listen(Session, "before_commit", fail_commit)
    try:
        with TestClient(
            app, base_url="http://127.0.0.1", raise_server_exceptions=False
        ) as connection:
            result = connection.post(
                "/api/v1/auth/register",
                json={
                    "email": failed_email,
                    "name": "Commit failure",
                    "password": "commit order validation password",
                    **failed_verification,
                },
            )
        assert result.status_code == 500
        assert (
            "access_token" not in result.text
            and "isolated commit failure" not in result.text
        )
    finally:
        event.remove(Session, "before_commit", fail_commit)
