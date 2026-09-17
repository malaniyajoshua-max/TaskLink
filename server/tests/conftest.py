import os
import base64
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
root = Path(__file__).resolve().parents[2] / "work" / "server-tests"
root.mkdir(parents=True, exist_ok=True)
os.environ["TASKLINK_DATABASE_URL"] = (
    f"sqlite:///{(root / (str(uuid4()) + '.db')).as_posix()}"
)

os.environ["TASKLINK_DATA_KEY"] = base64.b64encode(os.urandom(32)).decode()
os.environ["TASKLINK_ENV"] = "test"
os.environ["TASKLINK_TEST_EMAIL_CODE"] = "246810"

TEST_EMAIL_CODE = "246810"

import pytest
from fastapi.testclient import TestClient
from app.db import init_db
from app.main import app, rate_windows

init_db()


@pytest.fixture
def client():
    rate_windows.clear()
    with TestClient(app, base_url="http://127.0.0.1") as c:
        yield c


@pytest.fixture
def email_verification(client):
    def issue(email):
        response = client.post("/api/v1/auth/register/code", json={"email": email})
        assert response.status_code == 202, response.text
        return {
            "email_verification_id": response.json()["request_id"],
            "email_verification_code": TEST_EMAIL_CODE,
        }

    return issue


@pytest.fixture
def accounts(client, email_verification):
    def register(name="Alice"):
        email = f"{name.lower()}-{uuid4().hex[:10]}@example.com"
        result = client.post(
            "/api/v1/auth/register",
            json=dict(
                email=email,
                name=name,
                password="correct horse battery",
                **email_verification(email),
            ),
        ).json()
        return result, {"Authorization": f"Bearer {result['access_token']}"}

    return register
