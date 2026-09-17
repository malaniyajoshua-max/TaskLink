import base64
import hashlib
import io
from uuid import uuid4
from PIL import Image
from sqlalchemy import text
from app.db import engine
from app.attachments import CHUNK_BYTES


def friends(client, accounts):
    a, ah = accounts("MediaAlice")
    b, bh = accounts("MediaBob")
    f = client.post(
        "/api/v1/friends", headers=ah, json={"email": b["user"]["email"]}
    ).json()
    assert (
        client.post(
            f"/api/v1/friends/{f['id']}/decision", headers=bh, json={"accept": True}
        ).status_code
        == 200
    )
    return a, ah, b, bh, f


def start(client, headers, peer, data, name):
    value = dict(
        id=str(uuid4()),
        recipient_id=peer,
        name=name,
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    response = client.post("/api/v1/attachments", headers=headers, json=value)
    assert response.status_code == 201, response.text
    return value


def upload(client, headers, value, data):
    for number, offset in enumerate(range(0, len(data), CHUNK_BYTES)):
        response = client.put(
            f"/api/v1/attachments/{value['id']}/chunks/{number}",
            headers={**headers, "Content-Type": "application/octet-stream"},
            content=data[offset : offset + CHUNK_BYTES],
        )
        assert response.status_code == 204, response.text
    return client.post(f"/api/v1/attachments/{value['id']}/complete", headers=headers)


def image_bytes(animated=False):
    output = io.BytesIO()
    a = Image.new("RGB", (80, 60), "#515dec")
    b = Image.new("RGB", (80, 60), "#33b9b0")
    if animated:
        a.save(output, "GIF", save_all=True, append_images=[b], duration=120, loop=0)
    else:
        a.save(output, "PNG")
    return output.getvalue()


def test_attachment_chunks_permissions_idempotent_message_and_revocation(
    client, accounts
):
    a, ah, b, bh, f = friends(client, accounts)
    _, ch = accounts("MediaThird")
    data = ("分块传输与完整性验证\n" * 12000).encode()
    value = start(client, ah, b["user"]["id"], data, "会议资料.txt")
    assert upload(client, ah, value, data).status_code == 200
    route = f"/api/v1/attachments/{value['id']}"
    assert client.get(route, headers=bh).status_code == 403  # not sent yet
    assert client.get(route, headers=ch).status_code == 403
    body = dict(
        id=str(uuid4()),
        recipient_id=b["user"]["id"],
        body="文件已发送 👍",
        attachment_ids=[value["id"]],
    )
    sent = client.post("/api/v1/messages", headers=ah, json=body)
    assert sent.status_code == 201, sent.text
    assert client.post("/api/v1/messages", headers=ah, json=body).json() == sent.json()
    assert (
        client.post(
            "/api/v1/messages", headers=ah, json={**body, "attachment_ids": []}
        ).status_code
        == 409
    )
    assert client.get(route, headers=bh).json()["name"] == "会议资料.txt"
    received = b"".join(
        client.get(f"{route}/chunks/{i}", headers=bh).content
        for i in range((len(data) + CHUNK_BYTES - 1) // CHUNK_BYTES)
    )
    assert received == data
    assert client.get(route + "/chunks/0", headers=ch).status_code == 403
    assert client.get(route + "/chunks/0").status_code == 401
    assert client.delete(route, headers=ah).status_code == 409
    assert (
        client.post(
            "/api/v1/messages",
            headers=bh,
            json={
                "id": str(uuid4()),
                "recipient_id": a["user"]["id"],
                "attachment_ids": [value["id"]],
            },
        ).status_code
        == 403
    )
    with engine.connect() as db:
        stored = db.execute(
            text("SELECT payload FROM attachment_chunks WHERE attachment_id=:id"),
            {"id": value["id"]},
        ).first()[0]
        metadata = db.execute(
            text("SELECT details FROM attachments WHERE id=:id"), {"id": value["id"]}
        ).first()[0]
        assert data[:64] not in bytes(stored) and "会议资料" not in metadata
    assert client.delete(f"/api/v1/friends/{f['id']}", headers=bh).status_code == 200
    assert client.get(route + "/chunks/0", headers=bh).status_code == 403


def test_image_animation_sticker_and_avatar_are_real_validated_media(client, accounts):
    a, ah, b, bh, _ = friends(client, accounts)
    data = image_bytes(animated=True)
    value = start(client, ah, b["user"]["id"], data, "收到.gif")
    result = upload(client, ah, value, data)
    assert result.status_code == 200 and result.json()["kind"] == "image", result.text
    sent = client.post(
        "/api/v1/messages",
        headers=ah,
        json={
            "id": str(uuid4()),
            "recipient_id": b["user"]["id"],
            "sticker_id": "received",
            "attachment_ids": [value["id"]],
        },
    )
    assert sent.status_code == 201 and sent.json()["sticker_id"] == "received"
    preview = client.get(f"/api/v1/attachments/{value['id']}/preview", headers=bh)
    assert preview.headers["content-type"] == "image/webp"
    with Image.open(io.BytesIO(preview.content)) as image:
        assert image.n_frames == 2 and image.size == (80, 60)
    avatar = client.put(
        "/api/v1/profile/avatar",
        headers=ah,
        json={"data": base64.b64encode(image_bytes()).decode()},
    )
    assert avatar.status_code == 200, avatar.text
    assert avatar.json()["avatar"].startswith("data:image/webp;base64,")
    peer = client.get("/api/v1/friends", headers=bh).json()[0]["user"]
    assert peer["avatar"] == avatar.json()["avatar"]
    with Image.open(
        io.BytesIO(base64.b64decode(peer["avatar"].split(",")[1]))
    ) as image:
        assert image.size == (128, 128)
    assert (
        client.post(
            "/api/v1/messages",
            headers=ah,
            json={"id": str(uuid4()), "recipient_id": b["user"]["id"], "body": " "},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/v1/messages",
            headers=ah,
            json={
                "id": str(uuid4()),
                "recipient_id": b["user"]["id"],
                "sticker_id": "arbitrary-script",
            },
        ).status_code
        == 422
    )


def test_upload_rejects_paths_wrong_types_corruption_and_missing_chunks(
    client, accounts
):
    a, ah, b, bh, _ = friends(client, accounts)
    data = b"test text"
    base = dict(
        id=str(uuid4()),
        recipient_id=b["user"]["id"],
        name="data.txt",
        size=len(data),
        sha256=hashlib.sha256(data).hexdigest(),
    )
    for name in [
        "../secret.txt",
        "script.exe",
        "active.svg",
        "CON.txt",
        "x.txt:secret",
        "bad\u202efdp.txt",
    ]:
        assert (
            client.post(
                "/api/v1/attachments", headers=ah, json={**base, "name": name}
            ).status_code
            == 422
        )
    assert (
        client.post(
            "/api/v1/attachments",
            headers=ah,
            json={**base, "size": 25 * 1024 * 1024 + 1},
        ).status_code
        == 422
    )
    value = start(client, ah, b["user"]["id"], data, "not-image.png")
    assert (
        client.post(
            f"/api/v1/attachments/{value['id']}/complete", headers=ah
        ).status_code
        == 409
    )
    assert upload(client, ah, value, data).status_code == 422
    value = start(client, ah, b["user"]["id"], data, "checksums.txt")
    route = f"/api/v1/attachments/{value['id']}"
    headers = {**ah, "Content-Type": "application/octet-stream"}
    assert (
        client.put(route + "/chunks/0", headers=headers, content=data[:-1]).status_code
        == 422
    )
    assert (
        client.put(
            route + "/chunks/0", headers=headers, content=b"different"
        ).status_code
        == 204
    )
    assert (
        client.put(route + "/chunks/0", headers=headers, content=data).status_code
        == 409
    )
    assert client.post(route + "/complete", headers=ah).status_code == 409
    assert client.delete(route, headers=bh).status_code == 403
    assert client.delete(route, headers=ah).status_code == 204
    with engine.connect() as db:
        assert (
            db.execute(
                text("SELECT count(*) FROM attachment_chunks WHERE attachment_id=:id"),
                {"id": value["id"]},
            ).scalar()
            == 0
        )
