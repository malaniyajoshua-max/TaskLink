"""Application service for bounded, authenticated, encrypted chat media.

Original bytes are never rendered as documents or extracted. Image previews are
decoded with pixel/frame budgets and re-encoded without original metadata.
"""

import base64
import hashlib
import io
import math
import os
import re
import time
import warnings
from pathlib import PurePosixPath
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image, ImageOps, UnidentifiedImageError
from .content_crypto import data_key
from .domain import require, DomainError
from .models import Attachment, AttachmentChunk

CHUNK_BYTES = 256 * 1024
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_ACCOUNT_BYTES = 512 * 1024 * 1024
IMAGE_EXTENSIONS = {
    ".png": "PNG",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".gif": "GIF",
    ".webp": "WEBP",
}
FILE_EXTENSIONS = {
    ".txt",
    ".md",
    ".csv",
    ".json",
    ".pdf",
    ".docx",
    ".xlsx",
    ".pptx",
    ".odt",
    ".ods",
    ".odp",
    ".zip",
    ".7z",
}


def valid_name(name):
    require(
        0 < len(name) <= 180
        and name == name.strip()
        and not name.startswith(".")
        and not re.search(r'[<>:"/\\|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]', name)
        and not name.endswith((" ", "."))
        and not re.match(
            r"^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)", name, re.I
        ),
        "invalid_filename",
        "文件名包含不允许的字符",
        422,
    )
    extension = PurePosixPath(name).suffix.lower()
    require(
        extension in IMAGE_EXTENSIONS or extension in FILE_EXTENSIONS,
        "file_type_denied",
        "不支持此文件类型；可发送图片、PDF、文本、常用 Office 文档或压缩包",
        422,
    )
    return extension


def seal_bytes(data, scope):
    nonce = os.urandom(12)
    return nonce + AESGCM(data_key()).encrypt(
        nonce, data, ("tasklink:media:" + scope).encode()
    )


def open_bytes(data, scope):
    try:
        return AESGCM(data_key()).decrypt(
            data[:12], data[12:], ("tasklink:media:" + scope).encode()
        )
    except Exception:
        raise DomainError("attachment_integrity", "附件完整性校验失败", 409) from None


def image_preview(data, expected=None, avatar=False):
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                require(
                    source.format in IMAGE_EXTENSIONS.values()
                    and (not expected or source.format == expected),
                    "image_type",
                    "图片内容与文件类型不符",
                    422,
                )
                width, height = source.size
                frames = getattr(source, "n_frames", 1)
                require(
                    width > 0
                    and height > 0
                    and width * height <= 20_000_000
                    and frames <= 120
                    and width * height * frames <= 100_000_000,
                    "image_dimensions",
                    "图片像素或动画帧数超过安全限制",
                    422,
                )
                images, durations = [], []
                for index in range(1 if avatar else frames):
                    source.seek(index)
                    frame = ImageOps.exif_transpose(source).convert("RGBA")
                    if avatar:
                        frame = ImageOps.fit(frame, (128, 128))
                    else:
                        frame.thumbnail((640, 480) if frames == 1 else (320, 320))
                    images.append(frame)
                    durations.append(
                        max(40, min(int(source.info.get("duration", 100)), 10000))
                    )
                output = io.BytesIO()
                images[0].save(
                    output,
                    format="WEBP",
                    quality=82,
                    method=3,
                    save_all=len(images) > 1,
                    append_images=images[1:],
                    duration=durations,
                    loop=0,
                )
                result = output.getvalue()
                require(
                    len(result) <= (64 * 1024 if avatar else 1024 * 1024),
                    "preview_too_large",
                    "图片预览过大，请缩小图片后发送",
                    422,
                )
                media_type = Image.MIME[source.format]
                return result, media_type
    except DomainError:
        raise
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        SyntaxError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ):
        raise DomainError("invalid_image", "图片损坏或不符合安全限制", 422) from None


def validate_file(data, extension):
    if extension == ".pdf":
        require(
            data.startswith(b"%PDF-"), "file_signature", "PDF 内容与扩展名不符", 422
        )
    elif extension in {".zip", ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}:
        require(
            data.startswith((b"PK\x03\x04", b"PK\x05\x06")),
            "file_signature",
            "文档或压缩包格式无效",
            422,
        )
    elif extension == ".7z":
        require(
            data.startswith(b"7z\xbc\xaf\x27\x1c"),
            "file_signature",
            "压缩包格式无效",
            422,
        )
    else:
        require(
            b"\0" not in data and not data.startswith((b"MZ", b"\x7fELF")),
            "file_signature",
            "文件不是支持的文本格式",
            422,
        )


class AttachmentService:
    def __init__(self, repo, user):
        self.repo, self.user = repo, user

    def friend(self, peer):
        row = self.repo.friend_pair(self.user.id, peer)
        require(
            row is not None and row.status == "accepted",
            "friend_required",
            "仅可向已确认的好友传输附件",
            403,
        )

    def owned(self, attachment_id):
        row = self.repo.get(Attachment, attachment_id)
        require(
            row is not None and row.sender_id == self.user.id,
            "attachment_forbidden",
            "没有此附件的操作权限",
            403,
        )
        return row

    def readable(self, attachment_id):
        row = self.repo.get(Attachment, attachment_id)
        require(
            row is not None
            and row.ready
            and (
                row.sender_id == self.user.id
                or (row.recipient_id == self.user.id and row.message_id is not None)
            ),
            "attachment_forbidden",
            "没有此附件的读取权限",
            403,
        )
        self.friend(
            row.recipient_id if row.sender_id == self.user.id else row.sender_id
        )
        return row

    @staticmethod
    def metadata(row):
        return dict(
            id=row.id,
            name=row.details["name"],
            size=row.size,
            sha256=row.sha256,
            kind=row.details["kind"],
            media_type=row.details["media_type"],
        )

    def begin(self, data):
        self.repo.lock_clock()
        extension = valid_name(data.name)
        self.friend(data.recipient_id)
        row = self.repo.get(Attachment, data.id)
        if row:
            require(
                row.sender_id == self.user.id
                and row.recipient_id == data.recipient_id
                and row.details["name"] == data.name
                and row.size == data.size
                and row.sha256 == data.sha256,
                "attachment_id_reused",
                "附件 ID 与原始内容不一致",
                409,
            )
        else:
            self.repo.expire_attachments(self.user.id, int(time.time()))
            require(
                self.repo.attachment_usage(self.user.id) + data.size
                <= MAX_ACCOUNT_BYTES,
                "attachment_quota",
                "附件存储已达到当前账号 512 MB 上限",
                413,
            )
            row = self.repo.add(
                Attachment(
                    id=data.id,
                    sender_id=self.user.id,
                    recipient_id=data.recipient_id,
                    size=data.size,
                    sha256=data.sha256,
                    ready=False,
                    expires_at=int(time.time()) + 86400,
                    details=dict(
                        name=data.name,
                        kind="image" if extension in IMAGE_EXTENSIONS else "file",
                        media_type="application/octet-stream",
                    ),
                )
            )
        return {
            **self.metadata(row),
            "ready": row.ready,
            "uploaded_chunks": self.repo.attachment_numbers(row.id),
        }

    def chunk(self, attachment_id, number, payload):
        self.repo.lock_clock()
        row = self.owned(attachment_id)
        self.friend(row.recipient_id)
        total = math.ceil(row.size / CHUNK_BYTES)
        require(
            0 <= number < total
            and len(payload) == min(CHUNK_BYTES, row.size - number * CHUNK_BYTES),
            "chunk_size",
            "附件分块长度或序号错误",
            422,
        )
        old = self.repo.get(AttachmentChunk, (row.id, number))
        if old:
            require(
                open_bytes(old.payload, f"{row.id}:{number}") == payload,
                "chunk_reused",
                "附件分块内容不一致",
                409,
            )
            return
        require(not row.ready, "attachment_ready", "附件已完成上传", 409)
        self.repo.add(
            AttachmentChunk(
                attachment_id=row.id,
                number=number,
                payload=seal_bytes(payload, f"{row.id}:{number}"),
            )
        )

    def complete(self, attachment_id):
        self.repo.lock_clock()
        row = self.owned(attachment_id)
        self.friend(row.recipient_id)
        if row.ready:
            return self.metadata(row)
        chunks = self.repo.attachment_chunks(row.id)
        require(
            [c.number for c in chunks]
            == list(range(math.ceil(row.size / CHUNK_BYTES))),
            "upload_incomplete",
            "附件尚未上传完整，可重试继续上传",
            409,
        )
        data = b"".join(open_bytes(c.payload, f"{row.id}:{c.number}") for c in chunks)
        require(
            len(data) == row.size and hashlib.sha256(data).hexdigest() == row.sha256,
            "attachment_checksum",
            "附件长度或 SHA256 校验失败",
            409,
        )
        extension = valid_name(row.details["name"])
        if extension in IMAGE_EXTENSIONS:
            preview, media_type = image_preview(data, IMAGE_EXTENSIONS[extension])
            row.preview = seal_bytes(preview, f"{row.id}:preview")
            row.details = {**row.details, "media_type": media_type}
        else:
            validate_file(data, extension)
        row.ready = True
        self.repo.flush()
        return self.metadata(row)

    def info(self, attachment_id):
        return self.metadata(self.readable(attachment_id))

    def download(self, attachment_id, number):
        row = self.readable(attachment_id)
        chunk = self.repo.get(AttachmentChunk, (row.id, number))
        require(chunk is not None, "chunk_not_found", "附件分块不存在", 404)
        return open_bytes(chunk.payload, f"{row.id}:{number}")

    def preview(self, attachment_id):
        row = self.readable(attachment_id)
        require(
            row.preview is not None, "preview_unavailable", "此附件没有图片预览", 404
        )
        return open_bytes(row.preview, f"{row.id}:preview")

    def discard(self, attachment_id):
        self.repo.lock_clock()
        row = self.owned(attachment_id)
        require(
            row.message_id is None,
            "attachment_bound",
            "已发送的附件不能作为草稿删除",
            409,
        )
        self.repo.remove_attachment(row)

    def for_message(self, ids, recipient_id):
        result = []
        for attachment_id in ids:
            row = self.owned(attachment_id)
            require(
                row.ready
                and row.recipient_id == recipient_id
                and row.message_id is None,
                "attachment_invalid",
                "附件未上传完成、已发送或收件人不匹配",
                409,
            )
            result.append(row)
        return result


def avatar_data(encoded):
    try:
        data = base64.b64decode(encoded, validate=True)
    except ValueError:
        raise DomainError("invalid_image", "头像数据格式错误", 422) from None
    require(len(data) <= 5 * 1024 * 1024, "avatar_size", "头像不能超过 5 MB", 413)
    preview, _ = image_preview(data, avatar=True)
    return "data:image/webp;base64," + base64.b64encode(preview).decode()
