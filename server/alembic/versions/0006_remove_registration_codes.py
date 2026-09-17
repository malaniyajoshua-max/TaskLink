"""Remove the obsolete operator registration-code gate.

Revision ID: 0006
Revises: 0005
"""

from alembic import op
import sqlalchemy as sa

revision = "0006_remove_registration_codes"
down_revision = "0005_email_verification"
branch_labels = None
depends_on = None


def upgrade():
    op.drop_index("ix_registration_codes_code_hash", table_name="registration_codes")
    op.drop_table("registration_codes")


def downgrade():
    op.create_table(
        "registration_codes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("uses_remaining", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(length=40), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_registration_codes_code_hash",
        "registration_codes",
        ["code_hash"],
        unique=True,
    )
