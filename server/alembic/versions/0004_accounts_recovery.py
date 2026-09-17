"""Registration codes, public account identifiers and password recovery."""

from alembic import op
import sqlalchemy as sa
import hashlib

revision = "0004_accounts_recovery"
down_revision = "0003_chat_media"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("users", sa.Column("account_id", sa.String(16), nullable=True))
    connection = op.get_bind()
    used = set()
    for (user_id,) in connection.execute(sa.text("SELECT id FROM users")):
        seed = int(hashlib.sha256(user_id.encode()).hexdigest()[:16], 16)
        for offset in range(100_000_000):
            number = (seed + offset) % 100_000_000
            account_id = f"TL-{number // 10000:04d}-{number % 10000:04d}"
            if account_id not in used:
                used.add(account_id)
                connection.execute(
                    sa.text("UPDATE users SET account_id=:account_id WHERE id=:id"),
                    {"account_id": account_id, "id": user_id},
                )
                break
    op.create_index("ix_users_account_id", "users", ["account_id"], unique=True)
    if connection.dialect.name == "sqlite":
        # SQLite cannot rebuild this referenced table with foreign keys enabled.
        # Triggers give new and updated rows the same non-null guarantee without
        # dropping the users table or its child references.
        connection.exec_driver_sql("""
            CREATE TRIGGER users_account_id_required_insert
            BEFORE INSERT ON users
            WHEN NEW.account_id IS NULL
            BEGIN SELECT RAISE(ABORT, 'account_id is required'); END
            """)
        connection.exec_driver_sql("""
            CREATE TRIGGER users_account_id_required_update
            BEFORE UPDATE OF account_id ON users
            WHEN NEW.account_id IS NULL
            BEGIN SELECT RAISE(ABORT, 'account_id is required'); END
            """)
    else:
        op.create_check_constraint(
            "ck_users_account_id_required", "users", "account_id IS NOT NULL"
        )
    op.create_table(
        "registration_codes",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("label", sa.String(120), nullable=False),
        sa.Column("uses_remaining", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=True),
        sa.Column("revoked", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index(
        "ix_registration_codes_code_hash",
        "registration_codes",
        ["code_hash"],
        unique=True,
    )
    op.create_table(
        "password_resets",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.Integer(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("consumed", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.String(40), nullable=False),
    )
    op.create_index("ix_password_resets_user_id", "password_resets", ["user_id"])


def downgrade():
    raise RuntimeError(
        "Restore a verified backup instead of removing account and recovery data"
    )
