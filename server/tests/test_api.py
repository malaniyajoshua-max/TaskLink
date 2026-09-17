import time
from uuid import uuid4
from concurrent.futures import ThreadPoolExecutor
from app.db import SessionLocal
from app.models import AuthSession, User
from app.security import digest
from app.repositories import Repository
from app.main import app
from fastapi.testclient import TestClient


def operation(title="Write tests", **kwargs):
    op = dict(
        operation_id=str(uuid4()),
        entity_id=str(uuid4()),
        entity_type="task",
        action="upsert",
        base_version=0,
        workspace_id=None,
        payload={"title": title},
    )
    op.update(kwargs)
    return op


def push(client, headers, op):
    res = client.post("/api/v1/sync/push", headers=headers, json={"operations": [op]})
    assert res.status_code == 200, res.text
    return res.json()["results"][0]


def test_phase1_migration_health_contract_and_error(client):
    assert client.get("/health").json()["status"] == "ok"
    spec = client.get("/openapi.json").json()
    assert "HTTPBearer" in spec["components"]["securitySchemes"]
    assert "TaskBody" in spec["components"]["schemas"]
    response = client.get("/api/v1/tasks")
    assert response.status_code == 401
    assert set(response.json()) == {"code", "message", "request_id"}
    invalid = client.post(
        "/api/v1/auth/register",
        json=dict(
            email="bad",
            password="password-secret-value",
            name="",
        ),
    )
    assert invalid.status_code == 422
    assert "password-secret-value" not in invalid.text


def test_phase2_expired_access_rotation_logout(client, accounts):
    auth, headers = accounts()
    assert (
        client.post(
            "/api/v1/auth/login",
            json=dict(identifier=auth["user"]["email"], password="incorrect-password"),
        ).status_code
        == 401
    )
    with SessionLocal.begin() as db:
        row = Repository(db).access(digest(auth["access_token"]))
        row.access_expires = int(time.time()) - 1
    assert client.get("/api/v1/tasks", headers=headers).status_code == 401
    refreshed = client.post(
        "/api/v1/auth/refresh", json=dict(refresh_token=auth["refresh_token"])
    )
    assert refreshed.status_code == 200
    new = refreshed.json()
    assert new["refresh_token"] != auth["refresh_token"]
    assert (
        client.post(
            "/api/v1/auth/refresh", json=dict(refresh_token=auth["refresh_token"])
        ).status_code
        == 401
    )
    new_headers = {"Authorization": f"Bearer {new['access_token']}"}
    assert client.get("/api/v1/tasks", headers=new_headers).status_code == 200
    assert (
        client.post(
            "/api/v1/auth/logout", json=dict(refresh_token=new["refresh_token"])
        ).status_code
        == 204
    )
    assert client.get("/api/v1/tasks", headers=new_headers).status_code == 401


def test_phase2_create_edit_complete_subtasks_dates(client, accounts):
    _, headers = accounts()
    op = operation(payload=dict(title="Parent", due_at="2030-03-05T12:00:00+08:00"))
    row = push(client, headers, op)["entity"]
    assert row["body"]["due_at"] == "2030-03-05T04:00:00.000Z"
    child = operation(
        payload=dict(title="Child", parent_id=row["id"], due_at="2030-03-06T00:00:00Z")
    )
    assert push(client, headers, child)["code"] == "subtask_after_parent"
    child = operation(
        payload=dict(title="Child", parent_id=row["id"], inherit_due=True)
    )
    assert push(client, headers, child)["status"] == "applied"
    changed = operation(
        entity_id=row["id"],
        base_version=1,
        payload={**row["body"], "status": "done", "title": "Edited"},
    )
    assert push(client, headers, changed)["entity"]["body"]["status"] == "done"
    delete = operation(entity_id=row["id"], base_version=2, action="delete", payload={})
    assert push(client, headers, delete)["entity"]["deleted"]
    assert client.get("/api/v1/tasks", headers=headers).json() == []


def test_phase4_retry_fingerprint_version_and_cursor(client, accounts):
    _, headers = accounts()
    op = operation()
    first = push(client, headers, op)
    assert push(client, headers, op) == first
    assert (
        push(client, headers, {**op, "payload": {"title": "Hijack"}})["code"]
        == "operation_reused"
    )
    edit = operation(
        entity_id=op["entity_id"], base_version=1, payload={"title": "Device A"}
    )
    assert push(client, headers, edit)["status"] == "applied"
    conflict = operation(
        entity_id=op["entity_id"], base_version=1, payload={"title": "Device B"}
    )
    result = push(client, headers, conflict)
    assert (
        result["status"] == "conflict"
        and result["entity"]["body"]["title"] == "Device A"
    )
    page1 = client.get("/api/v1/sync/pull?limit=1", headers=headers).json()
    assert page1["has_more"] and len(page1["changes"]) == 1
    page2 = client.get(
        f"/api/v1/sync/pull?cursor={page1['cursor']}&limit=1", headers=headers
    ).json()
    assert page2["cursor"] > page1["cursor"]
    assert not page2["has_more"]
    assert (
        client.get(
            f"/api/v1/sync/pull?cursor={page2['cursor']}", headers=headers
        ).json()["changes"]
        == []
    )


def test_phase4_concurrent_devices_cannot_lose_update(client, accounts):
    _, headers = accounts()
    original = operation()
    push(client, headers, original)

    def write(title):
        with TestClient(app, base_url="http://127.0.0.1") as c:
            return push(
                c,
                headers,
                operation(
                    entity_id=original["entity_id"],
                    base_version=1,
                    payload={"title": title},
                ),
            )["status"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(write, ["One", "Two"]))
    assert sorted(outcomes) == ["applied", "conflict"]


def test_phase5_invitation_roles_and_revocation(client, accounts):
    owner, oh = accounts("Owner")
    viewer, vh = accounts("Viewer")
    outsider, xh = accounts("Outsider")
    ws = client.post("/api/v1/workspaces", headers=oh, json={"name": "Team"}).json()
    project = operation(
        entity_type="project", workspace_id=ws["id"], payload={"name": "Launch"}
    )
    assert push(client, oh, project)["status"] == "applied"
    assert push(client, xh, operation(workspace_id=ws["id"]))["code"] == "forbidden"
    invite = client.post(
        f"/api/v1/workspaces/{ws['id']}/invites",
        headers=oh,
        json={"email": viewer["user"]["email"], "role": "viewer"},
    ).json()
    assert client.get("/api/v1/projects", headers=vh).json() == []
    assert (
        client.post(
            f"/api/v1/invitations/{invite['id']}/decision",
            headers=xh,
            json={"accept": True},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/invitations/{invite['id']}/decision",
            headers=vh,
            json={"accept": True},
        ).status_code
        == 200
    )
    assert len(client.get("/api/v1/projects", headers=vh).json()) == 1
    assert push(client, vh, operation(workspace_id=ws["id"]))["code"] == "forbidden"
    assert (
        client.patch(
            f"/api/v1/workspaces/{ws['id']}", headers=vh, json={"name": "hack"}
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/v1/workspaces/{ws['id']}/members/{viewer['user']['id']}",
            headers=oh,
            json={"role": "member"},
        ).status_code
        == 200
    )
    assert (
        push(
            client,
            vh,
            operation(
                workspace_id=ws["id"],
                payload={"title": "Team work", "project_id": project["entity_id"]},
            ),
        )["status"]
        == "applied"
    )
    assert (
        client.delete(
            f"/api/v1/workspaces/{ws['id']}/members/{owner['user']['id']}", headers=oh
        ).status_code
        == 403
    )
    assert (
        client.delete(
            f"/api/v1/workspaces/{ws['id']}/members/{viewer['user']['id']}", headers=oh
        ).status_code
        == 200
    )
    assert client.get("/api/v1/projects", headers=vh).json() == []
    pull = client.get("/api/v1/sync/pull", headers=vh).json()
    project_events = [
        e["payload"] for e in pull["changes"] if e["entity_id"] == project["entity_id"]
    ]
    assert project_events and all(e.get("revoked") for e in project_events)


def test_phase5_friend_consent_chat_idempotency_and_privacy(client, accounts):
    alice, ah = accounts("Alice")
    bob, bh = accounts("Bob")
    _, outsider = accounts("Other")
    message = dict(id=str(uuid4()), recipient_id=bob["user"]["id"], body="Hello")
    assert client.post("/api/v1/messages", headers=ah, json=message).status_code == 403
    friend = client.post(
        "/api/v1/friends", headers=ah, json={"email": bob["user"]["email"]}
    ).json()
    assert (
        client.post(
            f"/api/v1/friends/{friend['id']}/decision",
            headers=ah,
            json={"accept": True},
        ).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/friends/{friend['id']}/decision",
            headers=bh,
            json={"accept": True},
        ).status_code
        == 200
    )
    first = client.post("/api/v1/messages", headers=ah, json=message)
    assert first.status_code == 201
    assert (
        client.post("/api/v1/messages", headers=ah, json=message).json() == first.json()
    )
    assert (
        len(client.get(f"/api/v1/messages/{alice['user']['id']}", headers=bh).json())
        == 1
    )
    assert (
        client.get(
            f"/api/v1/messages/{alice['user']['id']}", headers=outsider
        ).status_code
        == 403
    )
    notes = client.get("/api/v1/notifications", headers=bh).json()
    assert (
        client.post(
            f"/api/v1/notifications/{notes[0]['id']}/read", headers=ah
        ).status_code
        == 403
    )
    assert client.post(
        f"/api/v1/notifications/{notes[0]['id']}/read", headers=bh
    ).json()["read"]


def test_no_cross_account_reference_or_operation_leak(client, accounts):
    _, ah = accounts()
    _, bh = accounts()
    task = operation()
    push(client, ah, task)
    assert push(client, bh, task)["code"] == "forbidden"
    assert (
        push(
            client,
            bh,
            operation(payload=dict(title="Child", parent_id=task["entity_id"])),
        )["code"]
        == "forbidden"
    )
    project = operation(entity_type="project", payload={"name": "Private"})
    push(client, ah, project)
    assert (
        push(
            client,
            bh,
            operation(payload=dict(title="Task", project_id=project["entity_id"])),
        )["code"]
        == "forbidden"
    )


def test_batch_independent_failure_and_validation(client, accounts):
    _, headers = accounts()
    good = operation()
    bad = operation(payload={"title": "", "owner_id": str(uuid4())})
    res = client.post(
        "/api/v1/sync/push", headers=headers, json={"operations": [good, bad]}
    ).json()
    assert [r["status"] for r in res["results"]] == ["applied", "rejected"]
    assert len(client.get("/api/v1/tasks", headers=headers).json()) == 1


def test_password_spaces_are_not_silently_removed(client, email_verification):
    email = f"spaces-{uuid4()}@example.com"
    password = "  correct horse battery  "
    response = client.post(
        "/api/v1/auth/register",
        json={
            "name": "Spaces",
            "email": email,
            "password": password,
            **email_verification(email),
        },
    )
    assert response.status_code == 201
    assert (
        client.post(
            "/api/v1/auth/login",
            json={"identifier": email, "password": password.strip()},
        ).status_code
        == 401
    )
    assert (
        client.post(
            "/api/v1/auth/login", json={"identifier": email, "password": password}
        ).status_code
        == 200
    )


def test_parent_with_children_cannot_become_a_grandchild(client, accounts):
    _, headers = accounts()
    parent, other = operation(), operation()
    push(client, headers, parent)
    push(client, headers, other)
    push(
        client,
        headers,
        operation(payload={"title": "Child", "parent_id": parent["entity_id"]}),
    )
    result = push(
        client,
        headers,
        operation(
            entity_id=parent["entity_id"],
            base_version=1,
            payload={"title": "Moved", "parent_id": other["entity_id"]},
        ),
    )
    assert result["code"] == "nesting_limit"


def test_document_pagination_and_bulk_pull_permissions(client, accounts):
    from sqlalchemy import event
    from app.db import engine

    _, headers = accounts("PagedOwner")
    _, stranger = accounts("PagedStranger")
    operations = [operation(title=f"paged-{i}") for i in range(8)]
    response = client.post(
        "/api/v1/sync/push", headers=headers, json={"operations": operations}
    )
    assert all(r["status"] == "applied" for r in response.json()["results"])
    seen, after = [], ""
    while True:
        rows = client.get(
            "/api/v1/tasks", headers=headers, params={"limit": 3, "after": after}
        ).json()
        if not rows:
            break
        seen.extend(r["id"] for r in rows)
        after = rows[-1]["id"]
    assert seen == sorted(op["entity_id"] for op in operations)
    assert client.get("/api/v1/tasks?limit=501", headers=headers).status_code == 422
    assert client.get("/api/v1/tasks", headers=stranger).json() == []
    statements = []

    def observe(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", observe)
    try:
        result = client.get("/api/v1/sync/pull?limit=200", headers=headers)
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert len(result.json()["changes"]) == 8
    assert len(statements) <= 5  # auth session, user, changes, one authority query
