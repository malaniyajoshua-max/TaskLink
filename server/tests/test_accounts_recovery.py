from uuid import uuid4

from app.db import SessionLocal
from app.models import EmailVerification


def test_unique_account_and_email_login(client, email_verification):
    email = f"account-{uuid4()}@example.com"
    password = "account identifier acceptance"
    created = client.post(
        "/api/v1/auth/register",
        json={
            "name": "账号测试",
            "email": email,
            "password": password,
            **email_verification(email),
        },
    )
    assert created.status_code == 201, created.text
    user = created.json()["user"]
    assert user["account_id"].startswith("TL-") and len(user["account_id"]) == 12
    for identifier in (user["account_id"], email.upper()):
        result = client.post(
            "/api/v1/auth/login",
            json={"identifier": identifier, "password": password},
        )
        assert result.status_code == 200, result.text
        assert result.json()["user"]["id"] == user["id"]


def test_profile_nickname_update_is_persisted_and_validated(client, accounts):
    auth, headers = accounts("OriginalNickname")
    updated = client.patch(
        "/api/v1/profile", json={"name": "新的昵称"}, headers=headers
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "新的昵称"
    assert updated.json()["account_id"] == auth["user"]["account_id"]

    login = client.post(
        "/api/v1/auth/login",
        json={
            "identifier": auth["user"]["account_id"],
            "password": "correct horse battery",
        },
    )
    assert login.status_code == 200, login.text
    assert login.json()["user"]["name"] == "新的昵称"
    assert (
        client.patch(
            "/api/v1/profile", json={"name": "   "}, headers=headers
        ).status_code
        == 422
    )


def test_password_recovery_is_generic_one_time_and_revokes_sessions(
    client, accounts, monkeypatch
):
    auth, headers = accounts("Recovery")
    delivered = []
    monkeypatch.setattr(
        "app.routers.auth.send_password_reset",
        lambda email, nickname, code: delivered.append((email, nickname, code)),
    )
    unknown_email = f"missing-{uuid4()}@example.com"
    unknown = client.post(
        "/api/v1/auth/password/forgot",
        json={"email": unknown_email},
    )
    known = client.post(
        "/api/v1/auth/password/forgot", json={"email": auth["user"]["email"]}
    )
    assert unknown.status_code == known.status_code == 202
    assert (
        set(unknown.json())
        == set(known.json())
        == {
            "request_id",
            "expires_in",
            "resend_after",
        }
    )
    assert len(delivered) == 1
    repeated_unknown = client.post(
        "/api/v1/auth/password/forgot",
        json={"email": unknown_email},
    )
    repeated_known = client.post(
        "/api/v1/auth/password/forgot", json={"email": auth["user"]["email"]}
    )
    assert repeated_unknown.json()["request_id"] == unknown.json()["request_id"]
    assert repeated_known.json()["request_id"] == known.json()["request_id"]
    assert len(delivered) == 1
    email, nickname, code = delivered[0]
    assert email == auth["user"]["email"] and nickname == "Recovery"
    assert len(code) == 6 and code.isdigit()
    request_id = known.json()["request_id"]
    wrong = client.post(
        "/api/v1/auth/password/reset",
        json={
            "request_id": request_id,
            "code": "000000" if code != "000000" else "999999",
            "password": "new recovery password",
        },
    )
    assert wrong.status_code == 400
    reset = client.post(
        "/api/v1/auth/password/reset",
        json={
            "request_id": request_id,
            "code": code,
            "password": "new recovery password",
        },
    )
    assert reset.status_code == 200 and reset.json() == {"reset": True}
    assert client.get("/api/v1/tasks", headers=headers).status_code == 401
    assert (
        client.post(
            "/api/v1/auth/password/reset",
            json={
                "request_id": request_id,
                "code": code,
                "password": "another recovery password",
            },
        ).status_code
        == 400
    )
    old = client.post(
        "/api/v1/auth/login",
        json={
            "identifier": auth["user"]["account_id"],
            "password": "correct horse battery",
        },
    )
    new = client.post(
        "/api/v1/auth/login",
        json={
            "identifier": auth["user"]["account_id"],
            "password": "new recovery password",
        },
    )
    assert old.status_code == 401 and new.status_code == 200


def test_registration_email_code_is_delivered_limited_and_one_time(client, monkeypatch):
    delivered = []
    monkeypatch.setattr(
        "app.routers.auth.send_registration_verification",
        lambda email, code: delivered.append((email, code)),
    )
    email = f"verified-{uuid4()}@example.com"
    issued = client.post("/api/v1/auth/register/code", json={"email": email})
    assert issued.status_code == 202, issued.text
    assert issued.json()["expires_in"] == 600
    assert issued.json()["resend_after"] == 60
    assert delivered == [(email, "246810")]
    throttled = client.post("/api/v1/auth/register/code", json={"email": email})
    assert throttled.status_code == 202
    assert throttled.json()["request_id"] == issued.json()["request_id"]
    assert len(delivered) == 1

    payload = {
        "name": "邮箱验证",
        "email": email,
        "email_verification_id": issued.json()["request_id"],
        "password": "verified email password",
    }
    wrong = client.post(
        "/api/v1/auth/register",
        json={**payload, "email_verification_code": "000000"},
    )
    assert wrong.status_code == 400
    assert wrong.json()["code"] == "invalid_email_verification_code"
    with SessionLocal() as db:
        row = db.get(EmailVerification, issued.json()["request_id"])
        assert row.attempts == 1 and not row.consumed

    created = client.post(
        "/api/v1/auth/register",
        json={**payload, "email_verification_code": "246810"},
    )
    assert created.status_code == 201, created.text
    repeated = client.post(
        "/api/v1/auth/register",
        json={**payload, "email_verification_code": "246810"},
    )
    assert repeated.status_code == 400

    locked_email = f"locked-{uuid4()}@example.com"
    locked = client.post(
        "/api/v1/auth/register/code", json={"email": locked_email}
    ).json()
    locked_payload = {
        **payload,
        "email": locked_email,
        "email_verification_id": locked["request_id"],
        "email_verification_code": "000000",
    }
    for _ in range(5):
        assert (
            client.post("/api/v1/auth/register", json=locked_payload).status_code == 400
        )
    locked_payload["email_verification_code"] = "246810"
    assert client.post("/api/v1/auth/register", json=locked_payload).status_code == 400


def test_password_mail_rejects_plaintext_smtp(monkeypatch):
    from app.mailer import send_password_reset

    monkeypatch.setenv("TASKLINK_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("TASKLINK_SMTP_FROM", "no-reply@example.test")
    monkeypatch.setenv("TASKLINK_SMTP_SECURITY", "plain")
    try:
        send_password_reset("user@example.test", "用户", "123456")
    except RuntimeError as error:
        assert str(error) == "SMTP must use ssl or starttls"
    else:
        raise AssertionError("plaintext SMTP must never be accepted")


def test_registration_email_uses_tls_transport(monkeypatch):
    from app.mailer import send_registration_verification

    sent = []

    class SecureSMTP:
        def __init__(self, host, port, timeout, context):
            assert (host, port, timeout) == ("smtp.example.test", 465, 15)
            assert context is not None

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def send_message(self, email):
            sent.append(email)

    monkeypatch.setenv("TASKLINK_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("TASKLINK_SMTP_FROM", "no-reply@example.test")
    monkeypatch.setenv("TASKLINK_SMTP_SECURITY", "ssl")
    monkeypatch.setattr("app.mailer.smtplib.SMTP_SSL", SecureSMTP)
    send_registration_verification("member@example.test", "246810")
    assert len(sent) == 1
    assert sent[0]["To"] == "member@example.test"
    assert sent[0]["From"] == "no-reply@example.test"
    assert "246810" in sent[0].get_content()
