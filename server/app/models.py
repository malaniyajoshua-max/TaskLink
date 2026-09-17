from uuid import uuid4
from sqlalchemy import (
    Boolean,
    ForeignKey,
    Integer,
    JSON,
    CheckConstraint,
    String,
    Text,
    UniqueConstraint,
    Index,
    LargeBinary,
)
from sqlalchemy.orm import Mapped, mapped_column
from .db import Base
from .content_crypto import EncryptedJSON, EncryptedText


def new_id():
    return str(uuid4())


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    account_id: Mapped[str] = mapped_column(
        String(16), nullable=True, unique=True, index=True
    )
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(EncryptedText("users.name", 120))
    password_hash: Mapped[str] = mapped_column(String(256))
    avatar: Mapped[str | None] = mapped_column(
        EncryptedText("users.avatar"), nullable=True
    )
    __table_args__ = (
        CheckConstraint("account_id IS NOT NULL", name="ck_users_account_id_required"),
    )


class PasswordReset(Base):
    __tablename__ = "password_resets"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[int] = mapped_column(Integer)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40))


class EmailVerification(Base):
    __tablename__ = "email_verifications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), index=True)
    purpose: Mapped[str] = mapped_column(String(20), index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[int] = mapped_column(Integer)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    consumed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40))
    __table_args__ = (
        Index(
            "ix_email_verifications_lookup",
            "email",
            "purpose",
            "consumed",
        ),
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    access_hash: Mapped[str] = mapped_column(String(64), unique=True)
    refresh_hash: Mapped[str] = mapped_column(String(64), unique=True)
    access_expires: Mapped[int] = mapped_column(Integer)
    refresh_expires: Mapped[int] = mapped_column(Integer)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Workspace(Base):
    __tablename__ = "workspaces"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(EncryptedText("workspaces.name", 160))
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)


class Membership(Base):
    __tablename__ = "memberships"
    workspace_id: Mapped[str] = mapped_column(
        ForeignKey("workspaces.id"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    role: Mapped[str] = mapped_column(String(12))


class Invitation(Base):
    __tablename__ = "invitations"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(ForeignKey("workspaces.id"), index=True)
    email: Mapped[str] = mapped_column(String(320), index=True)
    role: Mapped[str] = mapped_column(String(12))
    inviter_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(12), default="pending")


class Document(Base):
    """Versioned tasks/projects. Body is strictly validated by their Pydantic contracts."""

    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(12), index=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    workspace_id: Mapped[str | None] = mapped_column(
        ForeignKey("workspaces.id"), nullable=True, index=True
    )
    body: Mapped[dict] = mapped_column(EncryptedJSON("documents.body"))
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    project_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    __table_args__ = (
        Index("ix_documents_parent_live", "parent_id", "deleted"),
        Index("ix_documents_project_live", "project_id", "deleted"),
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    updated_at: Mapped[str] = mapped_column(String(40))


class Operation(Base):
    __tablename__ = "operations"
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    operation_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    result: Mapped[dict] = mapped_column(EncryptedJSON("operations.result"))


class ChangeClock(Base):
    __tablename__ = "change_clock"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)


class ContentKeyCheck(Base):
    __tablename__ = "content_key_check"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    value: Mapped[str] = mapped_column(EncryptedText("key-check"))


class Change(Base):
    __tablename__ = "changes"
    sequence: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    kind: Mapped[str] = mapped_column(String(16))
    entity_id: Mapped[str] = mapped_column(String(36))
    payload: Mapped[dict] = mapped_column(EncryptedJSON("changes.payload"))
    __table_args__ = (Index("ix_changes_user_sequence", "user_id", "sequence"),)


class Friendship(Base):
    __tablename__ = "friendships"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    pair: Mapped[str] = mapped_column(String(73), unique=True)
    requester_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    addressee_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(12), default="pending")


class Message(Base):
    __tablename__ = "messages"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sender_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    recipient_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    body: Mapped[str] = mapped_column(EncryptedText("messages.body"))
    created_at: Mapped[str] = mapped_column(String(40))
    content: Mapped[dict | None] = mapped_column(
        EncryptedJSON("messages.content"), nullable=True
    )


class Attachment(Base):
    __tablename__ = "attachments"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    sender_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    recipient_id: Mapped[str] = mapped_column(ForeignKey("users.id"))
    message_id: Mapped[str | None] = mapped_column(
        ForeignKey("messages.id"), nullable=True
    )
    size: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    details: Mapped[dict] = mapped_column(EncryptedJSON("attachments.details"))
    ready: Mapped[bool] = mapped_column(Boolean, default=False)
    expires_at: Mapped[int] = mapped_column(Integer)
    preview: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    __table_args__ = (Index("ix_attachments_expiry", "message_id", "expires_at"),)


class AttachmentChunk(Base):
    __tablename__ = "attachment_chunks"
    attachment_id: Mapped[str] = mapped_column(
        ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True
    )
    number: Mapped[int] = mapped_column(Integer, primary_key=True)
    payload: Mapped[bytes] = mapped_column(LargeBinary)


class Notification(Base):
    __tablename__ = "notifications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    title: Mapped[str] = mapped_column(EncryptedText("notifications.title", 200))
    body: Mapped[str] = mapped_column(EncryptedText("notifications.body"))
    read: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str] = mapped_column(String(40))
