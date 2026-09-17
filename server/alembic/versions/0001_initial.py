"""Explicit schema for the first v2 release. Never import mutable application models."""

from alembic import op
import sqlalchemy as sa

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "users",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("password_hash", sa.String(256), nullable=False),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("access_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("refresh_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("access_expires", sa.Integer(), nullable=False),
        sa.Column("refresh_expires", sa.Integer(), nullable=False),
        sa.Column("revoked", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "workspaces",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("owner_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "memberships",
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id"),
            primary_key=True,
        ),
        sa.Column(
            "user_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True
        ),
        sa.Column("role", sa.String(12), nullable=False),
    )
    op.create_table(
        "invitations",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "workspace_id",
            sa.String(36),
            sa.ForeignKey("workspaces.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("email", sa.String(320), nullable=False, index=True),
        sa.Column("role", sa.String(12), nullable=False),
        sa.Column(
            "inviter_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("status", sa.String(12), nullable=False),
    )
    op.create_table(
        "documents",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("kind", sa.String(12), nullable=False, index=True),
        sa.Column(
            "owner_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "workspace_id", sa.String(36), sa.ForeignKey("workspaces.id"), index=True
        ),
        sa.Column("body", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False),
        sa.Column("updated_at", sa.String(40), nullable=False),
    )
    op.create_table(
        "operations",
        sa.Column(
            "user_id", sa.String(36), sa.ForeignKey("users.id"), primary_key=True
        ),
        sa.Column("operation_id", sa.String(36), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
    )
    op.create_table(
        "change_clock",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("value", sa.Integer(), nullable=False),
    )
    op.bulk_insert(
        sa.table(
            "change_clock",
            sa.column("id", sa.Integer()),
            sa.column("value", sa.Integer()),
        ),
        [{"id": 1, "value": 0}],
    )
    op.create_table(
        "changes",
        sa.Column("sequence", sa.Integer(), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("entity_id", sa.String(36), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
    )
    op.create_index("ix_changes_user_sequence", "changes", ["user_id", "sequence"])
    op.create_table(
        "friendships",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("pair", sa.String(73), nullable=False, unique=True),
        sa.Column(
            "requester_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "addressee_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("status", sa.String(12), nullable=False),
    )
    op.create_table(
        "messages",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "sender_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "recipient_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_table(
        "notifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "user_id",
            sa.String(36),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("read", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )


def downgrade():
    for name in (
        "notifications",
        "messages",
        "friendships",
        "changes",
        "change_clock",
        "operations",
        "documents",
        "invitations",
        "memberships",
        "workspaces",
        "auth_sessions",
        "users",
    ):
        op.drop_table(name)
