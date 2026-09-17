from datetime import datetime, timezone
from typing import Any, Literal, Annotated
from uuid import UUID
from pydantic import (
    BaseModel,
    ConfigDict,
    EmailStr,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


def identifier(v):
    return str(UUID(str(v)))


ID = Annotated[
    str,
    Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ),
]


class RegisterIn(StrictModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    email_verification_id: ID
    email_verification_code: str = Field(pattern=r"^[0-9]{6}$")
    password: Annotated[
        str, StringConstraints(strip_whitespace=False, min_length=10, max_length=128)
    ]


class LoginIn(StrictModel):
    identifier: str = Field(min_length=3, max_length=320)
    password: Annotated[
        str, StringConstraints(strip_whitespace=False, min_length=1, max_length=128)
    ]


class RefreshIn(StrictModel):
    refresh_token: str = Field(min_length=32, max_length=200)


class UserOut(StrictModel):
    id: ID
    account_id: str = Field(pattern=r"^TL-[0-9]{4}-[0-9]{4}$")
    email: str
    name: str
    avatar: str | None = None


class ProfileUpdateIn(StrictModel):
    name: str = Field(min_length=1, max_length=120)


class AuthOut(StrictModel):
    access_token: str
    refresh_token: str
    expires_in: int
    user: UserOut


class PasswordResetRequestIn(StrictModel):
    email: EmailStr


class PasswordResetRequestOut(StrictModel):
    request_id: ID
    expires_in: int = Field(gt=0, le=1800)
    resend_after: int = Field(gt=0, le=300)


class RegistrationVerificationRequestIn(StrictModel):
    email: EmailStr


class RegistrationVerificationRequestOut(StrictModel):
    request_id: ID
    expires_in: int = Field(gt=0, le=1800)
    resend_after: int = Field(gt=0, le=300)


class PasswordResetCompleteIn(StrictModel):
    request_id: ID
    code: str = Field(pattern=r"^[0-9]{6}$")
    password: Annotated[
        str, StringConstraints(strip_whitespace=False, min_length=10, max_length=128)
    ]


class PasswordResetCompleteOut(StrictModel):
    reset: bool


class TaskBody(StrictModel):
    title: str = Field(min_length=1, max_length=240)
    description: str = Field(default="", max_length=20000)
    status: Literal["todo", "in_progress", "done"] = "todo"
    priority: Literal["low", "medium", "high", "urgent"] = "medium"
    start_at: str | None = None
    due_at: str | None = None
    reminder_at: str | None = None
    project_id: ID | None = None
    parent_id: ID | None = None
    assignee_id: ID | None = None
    inherit_due: bool = False
    inherit_reminder: bool = False
    inherit_priority: bool = False

    @field_validator("start_at", "due_at", "reminder_at")
    @classmethod
    def dates(cls, value):
        if value is None:
            return value
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            raise ValueError("datetime_requires_timezone")
        return (
            dt.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )

    @model_validator(mode="after")
    def time_order(self):
        inherited_due = bool(self.parent_id and self.inherit_due)
        inherited_reminder = bool(self.parent_id and self.inherit_reminder)
        if (
            not inherited_due
            and self.start_at
            and self.due_at
            and self.start_at > self.due_at
        ):
            raise ValueError("start_after_due")
        if (
            not (inherited_due or inherited_reminder)
            and self.reminder_at
            and self.due_at
            and self.reminder_at > self.due_at
        ):
            raise ValueError("reminder_after_due")
        return self


class ProjectBody(StrictModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=20000)
    color: str = Field(default="#5367df", pattern=r"^#[0-9a-fA-F]{6}$")
    archived: bool = False


class EntityOut(StrictModel):
    id: ID
    kind: Literal["task", "project"]
    owner_id: ID
    workspace_id: ID | None
    body: TaskBody | ProjectBody
    version: int
    deleted: bool
    updated_at: str


class SyncOperation(StrictModel):
    operation_id: ID
    entity_id: ID
    entity_type: Literal["task", "project"]
    action: Literal["upsert", "delete"]
    base_version: int = Field(ge=0)
    workspace_id: ID | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class SyncPushIn(StrictModel):
    operations: list[SyncOperation] = Field(min_length=1, max_length=100)


class OperationResult(StrictModel):
    operation_id: ID
    status: Literal["applied", "conflict", "rejected"]
    entity: EntityOut | None = None
    code: str | None = None
    message: str | None = None


class SyncPushOut(StrictModel):
    results: list[OperationResult]


class ChangeOut(StrictModel):
    sequence: int
    kind: str
    entity_id: ID
    payload: dict[str, Any]


class SyncPullOut(StrictModel):
    cursor: int
    has_more: bool
    changes: list[ChangeOut]


class WorkspaceIn(StrictModel):
    name: str = Field(min_length=1, max_length=160)


class WorkspaceOut(WorkspaceIn):
    id: ID
    owner_id: ID
    role: Literal["owner", "admin", "member", "viewer"]
    version: int
    deleted: bool


class InviteIn(StrictModel):
    email: EmailStr
    role: Literal["admin", "member", "viewer"] = "member"


class DecisionIn(StrictModel):
    accept: bool


class RoleIn(StrictModel):
    role: Literal["admin", "member", "viewer"]


class FriendIn(StrictModel):
    email: EmailStr


StickerId = Literal["received", "great", "thanks", "cheer", "thinking", "celebrate"]


class AttachmentIn(StrictModel):
    id: ID
    recipient_id: ID
    name: str = Field(min_length=1, max_length=180)
    size: int = Field(gt=0, le=25 * 1024 * 1024)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")


class AttachmentOut(StrictModel):
    id: ID
    name: str
    size: int
    sha256: str
    kind: Literal["image", "file"]
    media_type: str


class UploadOut(AttachmentOut):
    ready: bool
    uploaded_chunks: list[int]


class AvatarIn(StrictModel):
    data: str = Field(min_length=1, max_length=7 * 1024 * 1024)


class MessageIn(StrictModel):
    id: ID
    recipient_id: ID
    body: str = Field(default="", max_length=4000)
    sticker_id: StickerId | None = None
    attachment_ids: list[ID] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def nonempty(self):
        if not self.body.strip() and not self.sticker_id and not self.attachment_ids:
            raise ValueError("An empty message cannot be sent")
        if len(set(self.attachment_ids)) != len(self.attachment_ids):
            raise ValueError("Duplicate attachment")
        return self


class StatusOut(StrictModel):
    status: str


class InviteCreatedOut(StatusOut):
    id: ID


class MemberOut(UserOut):
    role: Literal["owner", "admin", "member", "viewer"]


class InvitationOut(StrictModel):
    id: ID
    workspace_id: ID
    name: str
    role: Literal["admin", "member", "viewer"]


class FriendOut(StrictModel):
    id: ID
    user: UserOut
    status: Literal["pending", "accepted", "rejected"]
    incoming: bool


class MessageOut(StrictModel):
    id: ID
    sender_id: ID
    recipient_id: ID
    body: str
    created_at: str
    sticker_id: StickerId | None = None
    attachments: list[AttachmentOut] = Field(default_factory=list)


class NotificationOut(StrictModel):
    id: ID
    title: str
    body: str
    read: bool
    created_at: str


class ErrorOut(StrictModel):
    code: str
    message: str
    request_id: str
    details: list[dict] | None = None
