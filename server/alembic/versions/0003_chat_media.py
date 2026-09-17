"""Encrypted chat attachments, rich messages and profile avatars."""

from alembic import op
import sqlalchemy as sa

revision = "0003_chat_media"
down_revision = "0002_content_security"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("avatar", sa.Text(), nullable=True))
    op.add_column("messages", sa.Column("content", sa.JSON(), nullable=True))
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "sender_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "recipient_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "message_id", sa.String(36), sa.ForeignKey("messages.id"), nullable=True
        ),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.String(64), nullable=False),
        sa.Column("details", sa.JSON(), nullable=False),
        sa.Column("ready", sa.Boolean(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("preview", sa.LargeBinary(), nullable=True),
    )
    op.create_index("ix_attachments_sender_id", "attachments", ["sender_id"])
    op.create_index(
        "ix_attachments_expiry", "attachments", ["message_id", "expires_at"]
    )
    op.create_table(
        "attachment_chunks",
        sa.Column(
            "attachment_id",
            sa.String(36),
            sa.ForeignKey("attachments.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("number", sa.Integer(), primary_key=True),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
    )


def downgrade():
    raise RuntimeError(
        "Restore a verified backup instead of discarding chat attachments"
    )
