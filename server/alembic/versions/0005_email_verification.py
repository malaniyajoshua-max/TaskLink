"""Verified bound email during account registration."""

from alembic import op
import sqlalchemy as sa

revision = "0005_email_verification"
down_revision = "0004_accounts_recovery"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "email_verifications",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("purpose", sa.String(20), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("consumed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index(
        "ix_email_verifications_email",
        "email_verifications",
        ["email"],
    )
    op.create_index(
        "ix_email_verifications_purpose",
        "email_verifications",
        ["purpose"],
    )
    op.create_index(
        "ix_email_verifications_lookup",
        "email_verifications",
        ["email", "purpose", "consumed"],
    )


def downgrade():
    raise RuntimeError(
        "Restore a verified backup instead of removing email verification data"
    )
