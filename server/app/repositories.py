"""All database queries and persistence operations live here."""

from sqlalchemy import or_, select, func, delete
from sqlalchemy.orm import Session
from .models import (
    AuthSession,
    Change,
    ChangeClock,
    Document,
    Friendship,
    Invitation,
    Membership,
    Message,
    Notification,
    Operation,
    PasswordReset,
    EmailVerification,
    User,
    Workspace,
    Attachment,
    AttachmentChunk,
)


class Repository:
    def __init__(self, db: Session):
        self.db = db

    def add(self, row):
        self.db.add(row)
        self.db.flush()
        return row

    def get(self, model, key):
        return self.db.get(model, key)

    def delete(self, row):
        self.db.delete(row)
        self.db.flush()

    def savepoint(self):
        return self.db.begin_nested()

    def flush(self):
        self.db.flush()

    def lock_clock(self):
        return self.db.scalar(
            select(ChangeClock).where(ChangeClock.id == 1).with_for_update()
        )

    def user_by_email(self, email):
        return self.db.scalar(select(User).where(User.email == email.lower()))

    def user_by_account(self, account_id):
        return self.db.scalar(select(User).where(User.account_id == account_id))

    def password_reset(self, reset_id):
        return self.db.scalar(
            select(PasswordReset).where(PasswordReset.id == reset_id).with_for_update()
        )

    def email_verification(self, verification_id):
        return self.db.scalar(
            select(EmailVerification)
            .where(EmailVerification.id == verification_id)
            .with_for_update()
        )

    def active_email_verifications(self, email, purpose):
        return list(
            self.db.scalars(
                select(EmailVerification)
                .where(
                    EmailVerification.email == email.lower(),
                    EmailVerification.purpose == purpose,
                    EmailVerification.consumed.is_(False),
                )
                .with_for_update()
            )
        )

    def revoke_user_sessions(self, user_id):
        for row in self.db.scalars(
            select(AuthSession).where(
                AuthSession.user_id == user_id, AuthSession.revoked.is_(False)
            )
        ):
            row.revoked = True
        self.db.flush()

    def access(self, value):
        return self.db.scalar(
            select(AuthSession).where(AuthSession.access_hash == value)
        )

    def refresh(self, value):
        return self.db.scalar(
            select(AuthSession)
            .where(AuthSession.refresh_hash == value)
            .with_for_update()
        )

    def memberships(self, workspace_id):
        return list(
            self.db.scalars(
                select(Membership).where(Membership.workspace_id == workspace_id)
            )
        )

    def workspaces(self, user_id):
        return list(
            self.db.scalars(
                select(Workspace)
                .join(Membership)
                .where(Membership.user_id == user_id, Workspace.deleted.is_(False))
            )
        )

    def visible_document_condition(self, user_id):
        memberships = (
            select(Membership.workspace_id)
            .join(Workspace)
            .where(Membership.user_id == user_id, Workspace.deleted.is_(False))
        )
        return or_(
            (Document.owner_id == user_id) & (Document.workspace_id.is_(None)),
            Document.workspace_id.in_(memberships),
        )

    def readable_document_ids(self, user_id, entity_ids):
        if not entity_ids:
            return set()
        return set(
            self.db.scalars(
                select(Document.id).where(
                    Document.id.in_(entity_ids),
                    self.visible_document_condition(user_id),
                )
            )
        )

    def documents(self, user_id, kind=None, limit=200, after=""):
        q = select(Document).where(
            self.visible_document_condition(user_id),
            Document.deleted.is_(False),
            Document.id > after,
        )
        if kind:
            q = q.where(Document.kind == kind)
        return list(self.db.scalars(q.order_by(Document.id).limit(limit)))

    def children(self, entity_id, project=False):
        column = Document.project_id if project else Document.parent_id
        return list(
            self.db.scalars(
                select(Document).where(column == entity_id, Document.deleted.is_(False))
            )
        )

    def workspace_documents(self, workspace_id):
        return list(
            self.db.scalars(
                select(Document).where(Document.workspace_id == workspace_id)
            )
        )

    def workspace_invites(self, workspace_id):
        return list(
            self.db.scalars(
                select(Invitation).where(Invitation.workspace_id == workspace_id)
            )
        )

    def inbox_invites(self, email):
        return list(
            self.db.scalars(
                select(Invitation).where(
                    Invitation.email == email, Invitation.status == "pending"
                )
            )
        )

    def friendships(self, user_id):
        return list(
            self.db.scalars(
                select(Friendship).where(
                    or_(
                        Friendship.requester_id == user_id,
                        Friendship.addressee_id == user_id,
                    )
                )
            )
        )

    def friend_pair(self, a, b):
        pair = ":".join(sorted([a, b]))
        return self.db.scalar(select(Friendship).where(Friendship.pair == pair))

    def notifications(self, user_id):
        return list(
            self.db.scalars(
                select(Notification)
                .where(Notification.user_id == user_id)
                .order_by(Notification.created_at.desc())
            )
        )

    def messages(self, user_id, peer):
        return list(
            self.db.scalars(
                select(Message)
                .where(
                    or_(
                        (Message.sender_id == user_id) & (Message.recipient_id == peer),
                        (Message.sender_id == peer) & (Message.recipient_id == user_id),
                    )
                )
                .order_by(Message.created_at, Message.id)
            )
        )

    def change(self, user_id, kind, entity_id, payload):
        clock = self.lock_clock()
        clock.value += 1
        self.add(
            Change(
                sequence=clock.value,
                user_id=user_id,
                kind=kind,
                entity_id=entity_id,
                payload=payload,
            )
        )

    def attachment_chunks(self, attachment_id):
        return list(
            self.db.scalars(
                select(AttachmentChunk)
                .where(AttachmentChunk.attachment_id == attachment_id)
                .order_by(AttachmentChunk.number)
            )
        )

    def attachment_numbers(self, attachment_id):
        return list(
            self.db.scalars(
                select(AttachmentChunk.number)
                .where(AttachmentChunk.attachment_id == attachment_id)
                .order_by(AttachmentChunk.number)
            )
        )

    def attachment_usage(self, sender_id):
        return self.db.scalar(
            select(func.coalesce(func.sum(Attachment.size), 0)).where(
                Attachment.sender_id == sender_id
            )
        )

    def expire_attachments(self, sender_id, before):
        rows = list(
            self.db.scalars(
                select(Attachment)
                .where(
                    Attachment.sender_id == sender_id,
                    Attachment.message_id.is_(None),
                    Attachment.expires_at < before,
                )
                .limit(100)
            )
        )
        for row in rows:
            self.remove_attachment(row)

    def remove_attachment(self, row):
        self.db.execute(
            delete(AttachmentChunk).where(AttachmentChunk.attachment_id == row.id)
        )
        self.delete(row)

    def pull(self, user_id, cursor, limit):
        return list(
            self.db.scalars(
                select(Change)
                .where(Change.user_id == user_id, Change.sequence > cursor)
                .order_by(Change.sequence)
                .limit(limit + 1)
            )
        )
