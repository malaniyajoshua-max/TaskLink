"""Application services orchestrate domain rules and repository transactions."""

import hashlib
import hmac
import json
import math
import os
import secrets
import time
from pydantic import ValidationError
from datetime import datetime, timezone
from .domain import DomainError, can_admin, can_write, effective_task, now, require
from .models import (
    AuthSession,
    Document,
    EmailVerification,
    Friendship,
    Invitation,
    Membership,
    Message,
    Notification,
    Operation,
    PasswordReset,
    User,
    Workspace,
)
from .repositories import Repository
from .schemas import (
    AuthOut,
    EntityOut,
    PasswordResetRequestOut,
    ProjectBody,
    RegistrationVerificationRequestOut,
    SyncOperation,
    TaskBody,
    UserOut,
)
from .security import (
    DUMMY_PASSWORD_HASH,
    digest,
    hash_password,
    needs_rehash,
    token,
    verify_password,
)
from .attachments import AttachmentService, avatar_data
from .content_crypto import data_key


def user_out(user):
    return UserOut(
        id=user.id,
        account_id=user.account_id,
        email=user.email,
        name=user.name,
        avatar=user.avatar,
    ).model_dump()


def verification_digest(request_id: str, code: str) -> str:
    configured = os.environ.get("TASKLINK_RESET_PEPPER")
    key = configured.encode() if configured else data_key()
    return hmac.new(key, f"{request_id}:{code}".encode(), hashlib.sha256).hexdigest()


def verification_code() -> str:
    if os.environ.get("TASKLINK_ENV") == "test":
        fixed = os.environ.get("TASKLINK_TEST_EMAIL_CODE")
        if fixed and len(fixed) == 6 and fixed.isdigit():
            return fixed
    return f"{secrets.randbelow(1_000_000):06d}"


class AuthService:
    def __init__(self, repo: Repository):
        self.repo = repo

    def issue(self, user, session=None):
        access, refresh = token(), token()
        ttl = int(os.getenv("TASKLINK_ACCESS_TTL", "900"))
        ttl = max(1, min(ttl, 3600))
        values = dict(
            user_id=user.id,
            access_hash=digest(access),
            refresh_hash=digest(refresh),
            access_expires=int(time.time()) + ttl,
            refresh_expires=int(time.time()) + 30 * 86400,
            revoked=False,
        )
        if session:
            for key, value in values.items():
                setattr(session, key, value)
            self.repo.flush()
        else:
            self.repo.add(AuthSession(**values))
        return AuthOut(
            access_token=access,
            refresh_token=refresh,
            expires_in=ttl,
            user=user_out(user),
        )

    def register(self, data):
        self.repo.lock_clock()
        email = str(data.email).lower()
        verification = self.repo.email_verification(data.email_verification_id)
        valid_verification = (
            verification is not None
            and verification.email == email
            and verification.purpose == "register"
            and not verification.consumed
            and verification.expires_at > int(time.time())
            and verification.attempts < 5
        )
        if verification and not verification.consumed:
            verification.attempts += 1
        if not (
            valid_verification
            and secrets.compare_digest(
                verification.code_hash,
                verification_digest(
                    data.email_verification_id, data.email_verification_code
                ),
            )
        ):
            self.repo.flush()
            return DomainError(
                "invalid_email_verification_code",
                "邮箱验证码无效或已过期，请重新获取",
                400,
            )
        require(
            not self.repo.user_by_email(email),
            "email_exists",
            "该邮箱已经注册",
            409,
        )
        verification.consumed = True
        account_id = None
        for _ in range(32):
            candidate = (
                f"TL-{secrets.randbelow(10000):04d}-{secrets.randbelow(10000):04d}"
            )
            if not self.repo.user_by_account(candidate):
                account_id = candidate
                break
        if account_id is None:
            raise RuntimeError("Could not allocate a unique account identifier")
        user = self.repo.add(
            User(
                account_id=account_id,
                email=email,
                name=data.name,
                password_hash=hash_password(data.password),
            )
        )
        return self.issue(user)

    def login(self, data):
        value = data.identifier.strip()
        if "@" in value:
            try:
                from pydantic import TypeAdapter, EmailStr

                value = str(TypeAdapter(EmailStr).validate_python(value)).lower()
            except ValidationError:
                value = ""
            user = self.repo.user_by_email(value) if value else None
        else:
            value = value.upper()
            user = (
                self.repo.user_by_account(value)
                if value.startswith("TL-") and len(value) == 12
                else None
            )
        verified = verify_password(
            data.password, user.password_hash if user else DUMMY_PASSWORD_HASH
        )
        require(
            user is not None and verified,
            "invalid_credentials",
            "账号、邮箱或密码错误",
            401,
        )
        if needs_rehash(user.password_hash):
            user.password_hash = hash_password(data.password)
            self.repo.flush()
        return self.issue(user)

    def current(self, access):
        session = self.repo.access(digest(access))
        require(
            session is not None
            and not session.revoked
            and session.access_expires > time.time(),
            "session_expired",
            "登录已过期，请重新登录",
            401,
        )
        return self.repo.get(User, session.user_id)

    def refresh(self, value):
        row = self.repo.refresh(digest(value))
        require(
            row is not None and not row.revoked and row.refresh_expires > time.time(),
            "refresh_expired",
            "登录已过期，请重新登录",
            401,
        )
        return self.issue(self.repo.get(User, row.user_id), row)

    def logout(self, value):
        row = self.repo.refresh(digest(value))
        if row:
            row.revoked = True
            self.repo.flush()

    def request_password_reset(self, email):
        value = str(email).lower()
        active = self.repo.active_email_verifications(value, "password_reset")
        if active:
            latest = max(active, key=lambda row: row.created_at)
            created = datetime.fromisoformat(latest.created_at.replace("Z", "+00:00"))
            elapsed = (datetime.now(timezone.utc) - created).total_seconds()
            if elapsed < 60:
                return (
                    PasswordResetRequestOut(
                        request_id=latest.id,
                        expires_in=max(1, latest.expires_at - int(time.time())),
                        resend_after=max(1, math.ceil(60 - elapsed)),
                    ),
                    None,
                    None,
                )
        for previous in active:
            previous.consumed = True
        request_id = str(__import__("uuid").uuid4())
        user = self.repo.user_by_email(value)
        code = verification_code()
        code_hash = verification_digest(request_id, code)
        self.repo.add(
            EmailVerification(
                id=request_id,
                email=value,
                purpose="password_reset",
                code_hash=code_hash,
                expires_at=int(time.time()) + 600,
                attempts=0,
                consumed=False,
                created_at=now(),
            )
        )
        if user:
            self.repo.add(
                PasswordReset(
                    id=request_id,
                    user_id=user.id,
                    code_hash=code_hash,
                    expires_at=int(time.time()) + 600,
                    attempts=0,
                    consumed=False,
                    created_at=now(),
                )
            )
        return (
            PasswordResetRequestOut(
                request_id=request_id, expires_in=600, resend_after=60
            ),
            user,
            code if user else None,
        )

    def request_registration_verification(self, email):
        value = str(email).lower()
        active = self.repo.active_email_verifications(value, "register")
        if active:
            latest = max(active, key=lambda row: row.created_at)
            created = datetime.fromisoformat(latest.created_at.replace("Z", "+00:00"))
            elapsed = (datetime.now(timezone.utc) - created).total_seconds()
            if elapsed < 60:
                return (
                    RegistrationVerificationRequestOut(
                        request_id=latest.id,
                        expires_in=max(1, latest.expires_at - int(time.time())),
                        resend_after=max(1, math.ceil(60 - elapsed)),
                    ),
                    None,
                )
        request_id = str(__import__("uuid").uuid4())
        for previous in active:
            previous.consumed = True
        code = verification_code()
        self.repo.add(
            EmailVerification(
                id=request_id,
                email=value,
                purpose="register",
                code_hash=verification_digest(request_id, code),
                expires_at=int(time.time()) + 600,
                attempts=0,
                consumed=False,
                created_at=now(),
            )
        )
        return (
            RegistrationVerificationRequestOut(
                request_id=request_id, expires_in=600, resend_after=60
            ),
            None if self.repo.user_by_email(value) else code,
        )

    def complete_password_reset(self, data):
        row = self.repo.password_reset(data.request_id)
        valid = (
            row is not None
            and not row.consumed
            and row.expires_at > int(time.time())
            and row.attempts < 5
        )
        if row and not row.consumed:
            row.attempts += 1
        if not (
            valid
            and secrets.compare_digest(
                row.code_hash, verification_digest(data.request_id, data.code)
            )
        ):
            self.repo.flush()
            return DomainError(
                "invalid_reset_code",
                "验证码无效或已过期，请重新获取",
                400,
            )
        user = self.repo.get(User, row.user_id)
        user.password_hash = hash_password(data.password)
        row.consumed = True
        self.repo.revoke_user_sessions(user.id)
        self.repo.flush()
        return None


class DocumentService:
    def __init__(self, repo: Repository, user: User):
        self.repo, self.user = repo, user

    def role(self, workspace_id):
        if not workspace_id:
            return None
        ws = self.repo.get(Workspace, workspace_id)
        member = self.repo.get(Membership, (workspace_id, self.user.id))
        return member.role if ws and not ws.deleted and member else None

    def allowed(self, doc, write=False):
        if doc.workspace_id:
            role = self.role(doc.workspace_id)
            return can_write(role) if write else role is not None
        return doc.owner_id == self.user.id

    def entity(self, doc):
        return EntityOut(
            id=doc.id,
            kind=doc.kind,
            owner_id=doc.owner_id,
            workspace_id=doc.workspace_id,
            body=doc.body,
            version=doc.version,
            deleted=doc.deleted,
            updated_at=doc.updated_at,
        ).model_dump(mode="json")

    def get(self, entity_id, write=False, kind=None):
        row = self.repo.get(Document, entity_id)
        require(
            row is not None and self.allowed(row, write),
            "forbidden",
            "没有访问或修改此记录的权限",
            403,
        )
        require(
            not kind or row.kind == kind, "wrong_entity_type", "记录类型不匹配", 400
        )
        return row

    def list(self, kind, limit=200, after=""):
        return [
            self.entity(d)
            for d in self.repo.documents(self.user.id, kind, limit, after)
            if not d.deleted
        ]

    def audience(self, doc):
        return (
            [m.user_id for m in self.repo.memberships(doc.workspace_id)]
            if doc.workspace_id
            else [doc.owner_id]
        )

    def publish(self, doc):
        payload = self.entity(doc)
        for user_id in self.audience(doc):
            self.repo.change(user_id, doc.kind, doc.id, payload)

    def validate_refs(self, entity_id, body, workspace_id):
        parent = None
        if body.get("project_id"):
            project = self.get(body["project_id"], kind="project")
            require(
                not project.deleted and project.workspace_id == workspace_id,
                "invalid_project",
                "项目不存在或不属于当前工作区",
            )
        if body.get("parent_id"):
            require(
                body["parent_id"] != entity_id, "task_cycle", "任务不能以自身为父任务"
            )
            parent = self.get(body["parent_id"], kind="task")
            require(
                not parent.deleted
                and parent.workspace_id == workspace_id
                and parent.body.get("project_id") == body.get("project_id"),
                "invalid_parent",
                "父子任务必须属于同一项目和工作区",
            )
            require(
                not parent.body.get("parent_id"), "nesting_limit", "当前支持一级子任务"
            )
        if body.get("assignee_id"):
            if workspace_id:
                require(
                    self.repo.get(Membership, (workspace_id, body["assignee_id"]))
                    is not None,
                    "invalid_assignee",
                    "负责人必须是当前工作区成员",
                )
            else:
                require(
                    body["assignee_id"] == self.user.id,
                    "invalid_assignee",
                    "个人任务只能分配给自己",
                )
        effective_task(body, parent.body if parent else None)
        for doc in self.repo.children(entity_id):
            require(
                not body.get("parent_id"),
                "nesting_limit",
                "包含子任务的任务不能再成为子任务",
            )
            require(
                doc.workspace_id == workspace_id
                and doc.body.get("project_id") == body.get("project_id"),
                "children_scope",
                "请先移动或删除子任务，再修改父任务所属项目",
            )
            effective_task(doc.body, body)

    def apply(self, op: SyncOperation):
        self.repo.lock_clock()
        fingerprint = hashlib.sha256(op.model_dump_json().encode()).hexdigest()
        prior = self.repo.get(Operation, (self.user.id, op.operation_id))
        row = self.repo.get(Document, op.entity_id)
        if row:
            require(self.allowed(row, True), "forbidden", "没有修改此记录的权限", 403)
        elif op.workspace_id:
            require(
                can_write(self.role(op.workspace_id)),
                "forbidden",
                "当前角色不能创建记录",
                403,
            )
        if prior:
            require(
                prior.fingerprint == fingerprint,
                "operation_reused",
                "operation_id 已用于另一项操作",
                409,
            )
            return prior.result
        if row:
            require(
                row.kind == op.entity_type and row.workspace_id == op.workspace_id,
                "scope_changed",
                "不能通过同步改变记录类型或工作区",
            )
            if row.version != op.base_version:
                result = dict(
                    operation_id=op.operation_id,
                    status="conflict",
                    entity=self.entity(row),
                    code="version_conflict",
                    message="其他设备已经修改此记录；请选择保留本地或采用服务器版本",
                )
                self.repo.add(
                    Operation(
                        user_id=self.user.id,
                        operation_id=op.operation_id,
                        fingerprint=fingerprint,
                        result=result,
                    )
                )
                return result
            require(
                not row.deleted, "entity_deleted", "此记录已经删除，请另存为新记录", 409
            )
        else:
            require(
                op.base_version == 0 and op.action != "delete",
                "missing_entity",
                "记录不存在或创建版本无效",
                409,
            )

        if op.action == "upsert":
            schema = TaskBody if op.entity_type == "task" else ProjectBody
            body = schema.model_validate(op.payload).model_dump(mode="json")
            if op.entity_type == "task":
                self.validate_refs(op.entity_id, body, op.workspace_id)
            if row:
                row.body = body
                row.parent_id = body.get("parent_id")
                row.project_id = body.get("project_id")
                row.version += 1
                row.updated_at = now()
                self.repo.flush()
            else:
                row = self.repo.add(
                    Document(
                        id=op.entity_id,
                        kind=op.entity_type,
                        owner_id=self.user.id,
                        workspace_id=op.workspace_id,
                        body=body,
                        parent_id=body.get("parent_id"),
                        project_id=body.get("project_id"),
                        version=1,
                        deleted=False,
                        updated_at=now(),
                    )
                )
            self.publish(row)
        else:
            descendants = self.repo.children(row.id, project=row.kind == "project")
            for target in [*descendants, row]:
                target.deleted = True
                target.version += 1
                target.updated_at = now()
                self.repo.flush()
                self.publish(target)
        result = dict(
            operation_id=op.operation_id, status="applied", entity=self.entity(row)
        )
        self.repo.add(
            Operation(
                user_id=self.user.id,
                operation_id=op.operation_id,
                fingerprint=fingerprint,
                result=result,
            )
        )
        return result

    def push(self, operations):
        results = []
        for op in operations:
            try:
                with self.repo.savepoint():
                    result = self.apply(op)
            except DomainError as exc:
                result = dict(
                    operation_id=op.operation_id,
                    status="rejected",
                    code=exc.code,
                    message=exc.message,
                )
            except ValidationError:
                result = dict(
                    operation_id=op.operation_id,
                    status="rejected",
                    code="invalid_payload",
                    message="记录字段校验失败",
                )
            results.append(result)
        return dict(results=results)

    def pull(self, cursor, limit):
        rows = self.repo.pull(self.user.id, cursor, limit)
        has_more = len(rows) > limit
        rows = rows[:limit]
        # Validate current authority in one bounded metadata query; do not decrypt
        # and load a complete Document once for every historical change.
        readable = self.repo.readable_document_ids(
            self.user.id,
            [row.entity_id for row in rows if row.kind in ("task", "project")],
        )
        changes = []
        for row in rows:
            payload = row.payload
            if row.kind in ("task", "project"):
                if row.entity_id not in readable:
                    payload = dict(id=row.entity_id, deleted=True, revoked=True)
            elif row.kind == "workspace":
                ws = self.repo.get(Workspace, row.entity_id)
                role = self.role(row.entity_id)
                payload = (
                    CollaborationService(self.repo, self.user).workspace_out(ws, role)
                    if ws and role
                    else dict(id=row.entity_id, deleted=True, revoked=True)
                )
            changes.append(
                dict(
                    sequence=row.sequence,
                    kind=row.kind,
                    entity_id=row.entity_id,
                    payload=payload,
                )
            )
        return dict(
            cursor=rows[-1].sequence if rows else cursor,
            has_more=has_more,
            changes=changes,
        )


class CollaborationService:
    def __init__(self, repo: Repository, user: User):
        self.repo, self.user = repo, user
        self.docs = DocumentService(repo, user)

    def notification(self, user_id, title, body):
        row = self.repo.add(
            Notification(user_id=user_id, title=title, body=body, created_at=now())
        )
        self.repo.change(user_id, "notification", row.id, self.note_out(row))
        return row

    def note_out(self, row):
        return {
            key: getattr(row, key)
            for key in ("id", "title", "body", "read", "created_at")
        }

    def workspace_out(self, row, role):
        return dict(
            id=row.id,
            name=row.name,
            owner_id=row.owner_id,
            role=role,
            version=row.version,
            deleted=row.deleted,
        )

    def publish_workspace(self, row):
        for m in self.repo.memberships(row.id):
            self.repo.change(
                m.user_id, "workspace", row.id, self.workspace_out(row, m.role)
            )

    def workspaces(self):
        return [
            self.workspace_out(w, self.docs.role(w.id))
            for w in self.repo.workspaces(self.user.id)
        ]

    def workspace(self, workspace_id, admin=False):
        row = self.repo.get(Workspace, workspace_id)
        role = self.docs.role(workspace_id)
        require(
            row is not None and role is not None and (not admin or can_admin(role)),
            "forbidden",
            "没有管理工作区的权限",
            403,
        )
        return row

    def create_workspace(self, data):
        self.repo.lock_clock()
        row = self.repo.add(Workspace(name=data.name, owner_id=self.user.id))
        self.repo.add(
            Membership(workspace_id=row.id, user_id=self.user.id, role="owner")
        )
        self.publish_workspace(row)
        return self.workspace_out(row, "owner")

    def update_workspace(self, workspace_id, data):
        self.repo.lock_clock()
        row = self.workspace(workspace_id, True)
        row.name = data.name
        row.version += 1
        self.repo.flush()
        self.publish_workspace(row)
        return self.workspace_out(row, self.docs.role(row.id))

    def members(self, workspace_id):
        self.workspace(workspace_id)
        return [
            dict(**user_out(self.repo.get(User, m.user_id)), role=m.role)
            for m in self.repo.memberships(workspace_id)
        ]

    def invite(self, workspace_id, data):
        self.repo.lock_clock()
        ws = self.workspace(workspace_id, True)
        role = self.docs.role(workspace_id)
        require(
            data.role != "admin" or role == "owner",
            "owner_required",
            "只有所有者可以授予管理员角色",
            403,
        )
        email = str(data.email).lower()
        existing = self.repo.user_by_email(email)
        require(
            not existing or not self.repo.get(Membership, (workspace_id, existing.id)),
            "already_member",
            "对方已经是成员",
            409,
        )
        pending = [
            i
            for i in self.repo.workspace_invites(workspace_id)
            if i.email == email and i.status == "pending"
        ]
        require(not pending, "invite_exists", "已经有待处理的邀请", 409)
        row = self.repo.add(
            Invitation(
                workspace_id=workspace_id,
                email=email,
                role=data.role,
                inviter_id=self.user.id,
            )
        )
        if existing:
            self.notification(
                existing.id, "工作区邀请", f"{self.user.name} 邀请你加入 {ws.name}"
            )
        return dict(id=row.id, status=row.status)

    def invitations(self):
        return [
            dict(
                id=i.id,
                workspace_id=i.workspace_id,
                name=self.repo.get(Workspace, i.workspace_id).name,
                role=i.role,
            )
            for i in self.repo.inbox_invites(self.user.email)
        ]

    def decide_invite(self, invitation_id, accept):
        self.repo.lock_clock()
        row = self.repo.get(Invitation, invitation_id)
        require(
            row is not None and row.email == self.user.email,
            "forbidden",
            "不能处理他人的邀请",
            403,
        )
        require(row.status == "pending", "invite_closed", "邀请已处理", 409)
        row.status = "accepted" if accept else "rejected"
        if accept:
            ws = self.repo.get(Workspace, row.workspace_id)
            require(
                ws is not None and not ws.deleted,
                "workspace_deleted",
                "工作区已删除",
                409,
            )
            self.repo.add(
                Membership(workspace_id=ws.id, user_id=self.user.id, role=row.role)
            )
            self.repo.change(
                self.user.id, "workspace", ws.id, self.workspace_out(ws, row.role)
            )
            for doc in self.repo.workspace_documents(ws.id):
                self.repo.change(self.user.id, doc.kind, doc.id, self.docs.entity(doc))
        self.notification(
            row.inviter_id,
            "邀请已处理",
            f"{self.user.name} {'接受' if accept else '拒绝'}了工作区邀请",
        )
        return dict(status=row.status)

    def change_member(self, workspace_id, user_id, role=None):
        self.repo.lock_clock()
        ws = self.workspace(workspace_id, True)
        actor_role = self.docs.role(workspace_id)
        row = self.repo.get(Membership, (workspace_id, user_id))
        require(row is not None, "member_missing", "成员不存在", 404)
        require(
            row.role != "owner", "owner_protected", "不能移除或降级工作区所有者", 403
        )
        require(
            actor_role == "owner" or (row.role != "admin" and role != "admin"),
            "owner_required",
            "只有所有者可以修改管理员",
            403,
        )
        if role:
            row.role = role
            self.repo.flush()
            self.publish_workspace(ws)
        else:
            self.repo.delete(row)
            # Purge historical snapshots, including previously queued changes, on clients after revocation.
            self.repo.change(
                user_id, "workspace", ws.id, dict(id=ws.id, deleted=True, revoked=True)
            )
            for doc in self.repo.workspace_documents(ws.id):
                self.repo.change(
                    user_id,
                    doc.kind,
                    doc.id,
                    dict(id=doc.id, deleted=True, revoked=True, workspace_id=ws.id),
                )
        return dict(status="updated")

    def friend_out(self, row):
        peer_id = (
            row.addressee_id if row.requester_id == self.user.id else row.requester_id
        )
        return dict(
            id=row.id,
            user=user_out(self.repo.get(User, peer_id)),
            status=row.status,
            incoming=row.addressee_id == self.user.id,
        )

    def friends(self):
        return [self.friend_out(f) for f in self.repo.friendships(self.user.id)]

    def publish_friend(self, row):
        for user_id in (row.requester_id, row.addressee_id):
            service = CollaborationService(self.repo, self.repo.get(User, user_id))
            self.repo.change(user_id, "friend", row.id, service.friend_out(row))

    def add_friend(self, data):
        self.repo.lock_clock()
        peer = self.repo.user_by_email(str(data.email))
        require(
            peer is not None and peer.id != self.user.id,
            "user_not_found",
            "没有找到可添加的用户",
            404,
        )
        row = self.repo.friend_pair(self.user.id, peer.id)
        require(
            not row or row.status == "rejected",
            "friend_exists",
            "已经存在好友关系或申请",
            409,
        )
        if row:
            row.requester_id = self.user.id
            row.addressee_id = peer.id
            row.status = "pending"
            self.repo.flush()
        else:
            row = self.repo.add(
                Friendship(
                    pair=":".join(sorted([self.user.id, peer.id])),
                    requester_id=self.user.id,
                    addressee_id=peer.id,
                )
            )
        self.publish_friend(row)
        self.notification(peer.id, "好友申请", f"{self.user.name} 希望添加你为好友")
        return self.friend_out(row)

    def decide_friend(self, friendship_id, accept):
        self.repo.lock_clock()
        row = self.repo.get(Friendship, friendship_id)
        require(
            row is not None and row.addressee_id == self.user.id,
            "forbidden",
            "不能处理这项好友申请",
            403,
        )
        require(row.status == "pending", "request_closed", "申请已经处理", 409)
        row.status = "accepted" if accept else "rejected"
        self.repo.flush()
        self.publish_friend(row)
        return self.friend_out(row)

    def remove_friend(self, friendship_id):
        self.repo.lock_clock()
        row = self.repo.get(Friendship, friendship_id)
        require(
            row is not None and self.user.id in (row.requester_id, row.addressee_id),
            "forbidden",
            "没有权限",
            403,
        )
        row.status = "rejected"
        self.repo.flush()
        self.publish_friend(row)
        return dict(status="removed")

    def message_out(self, row):
        return {
            **{
                key: getattr(row, key)
                for key in ("id", "sender_id", "recipient_id", "body", "created_at")
            },
            "sticker_id": (row.content or {}).get("sticker_id"),
            "attachments": (row.content or {}).get("attachments", []),
        }

    def update_avatar(self, data):
        self.repo.lock_clock()
        self.user.avatar = avatar_data(data.data)
        self.repo.flush()
        for friend in self.repo.friendships(self.user.id):
            self.publish_friend(friend)
        return user_out(self.user)

    def update_profile(self, data):
        self.repo.lock_clock()
        self.user.name = data.name
        self.repo.flush()
        for friend in self.repo.friendships(self.user.id):
            self.publish_friend(friend)
        return user_out(self.user)

    def messages(self, peer):
        friend = self.repo.friend_pair(self.user.id, peer)
        require(
            friend is not None and friend.status == "accepted",
            "friend_required",
            "仅可查看已接受申请的好友消息",
            403,
        )
        return [self.message_out(m) for m in self.repo.messages(self.user.id, peer)]

    def send(self, data):
        self.repo.lock_clock()
        friend = self.repo.friend_pair(self.user.id, data.recipient_id)
        require(
            friend is not None and friend.status == "accepted",
            "friend_required",
            "仅可向已接受申请的好友发送消息",
            403,
        )
        prior = self.repo.get(Message, data.id)
        if prior:
            require(
                prior.sender_id == self.user.id
                and prior.recipient_id == data.recipient_id
                and prior.body == data.body,
                "message_id_reused",
                "消息 ID 已被使用",
                409,
            )
            require(
                (prior.content or {}).get("sticker_id") == data.sticker_id
                and [a["id"] for a in (prior.content or {}).get("attachments", [])]
                == data.attachment_ids,
                "message_id_reused",
                "消息 ID 已被使用",
                409,
            )
            return self.message_out(prior)
        media = AttachmentService(self.repo, self.user)
        attachments = media.for_message(data.attachment_ids, data.recipient_id)
        row = self.repo.add(
            Message(
                id=data.id,
                sender_id=self.user.id,
                recipient_id=data.recipient_id,
                body=data.body,
                created_at=now(),
                content={
                    "sticker_id": data.sticker_id,
                    "attachments": [media.metadata(a) for a in attachments],
                },
            )
        )
        for attachment in attachments:
            attachment.message_id = row.id
        self.repo.flush()
        payload = self.message_out(row)
        for user_id in (self.user.id, data.recipient_id):
            self.repo.change(user_id, "message", row.id, payload)
        self.notification(
            data.recipient_id,
            f"{self.user.name} 发来消息",
            data.body[:200] or ("[表情包]" if data.sticker_id else "[附件]"),
        )
        return payload

    def notifications(self):
        return [self.note_out(n) for n in self.repo.notifications(self.user.id)]

    def read_notification(self, notification_id):
        self.repo.lock_clock()
        row = self.repo.get(Notification, notification_id)
        require(
            row is not None and row.user_id == self.user.id,
            "forbidden",
            "没有权限",
            403,
        )
        row.read = True
        self.repo.flush()
        self.repo.change(self.user.id, "notification", row.id, self.note_out(row))
        return self.note_out(row)
