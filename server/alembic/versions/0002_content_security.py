"""Encrypt stored content and index task relationships without changing public IDs.

The v1 encryption codec is an explicit, versioned format retained for migration.
This migration requires the same key as the running server and cannot be undone
to plaintext by an automatic downgrade.
"""

import json
from alembic import op
import sqlalchemy as sa
from app.content_crypto import data_key, seal

revision = "0002_content_security"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade():
    data_key()  # Persist/verify the key BEFORE touching data.
    op.create_table(
        "content_key_check",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
    )
    op.get_bind().execute(
        sa.text("INSERT INTO content_key_check(id,value) VALUES(1,:value)"),
        {"value": seal("TaskLink content key v1", "key-check")},
    )
    op.add_column("documents", sa.Column("parent_id", sa.String(36), nullable=True))
    op.add_column("documents", sa.Column("project_id", sa.String(36), nullable=True))
    db = op.get_bind()
    for row in db.execute(sa.text("SELECT id,body FROM documents")).mappings():
        body = json.loads(row["body"]) if isinstance(row["body"], str) else row["body"]
        db.execute(
            sa.text(
                "UPDATE documents SET parent_id=:parent,project_id=:project WHERE id=:id"
            ),
            dict(
                parent=body.get("parent_id"),
                project=body.get("project_id"),
                id=row["id"],
            ),
        )
    op.create_index("ix_documents_parent_live", "documents", ["parent_id", "deleted"])
    op.create_index("ix_documents_project_live", "documents", ["project_id", "deleted"])
    for table, column in [
        ("users", "name"),
        ("workspaces", "name"),
        ("notifications", "title"),
    ]:
        if db.dialect.name != "sqlite":
            op.alter_column(
                table,
                column,
                existing_type=sa.String(),
                type_=sa.Text(),
                existing_nullable=False,
            )
    for table, fields, is_json in [
        ("documents", ["body"], True),
        ("operations", ["result"], True),
        ("changes", ["payload"], True),
        ("users", ["name"], False),
        ("workspaces", ["name"], False),
        ("messages", ["body"], False),
        ("notifications", ["title", "body"], False),
    ]:
        # Stream batches; do not materialize a customer's complete history in RAM.
        primary = {
            "operations": ["user_id", "operation_id"],
            "changes": ["sequence"],
        }.get(table, ["id"])
        columns = primary + fields
        result = db.execute(
            sa.text("SELECT " + ",".join(columns) + " FROM " + table)
        ).mappings()
        while rows := result.fetchmany(500):
            for row in rows:
                for field in fields:
                    value = row[field]
                    if is_json and not isinstance(value, str):
                        value = json.dumps(value, ensure_ascii=False)
                    encrypted = seal(value, table + "." + field)
                    statement = sa.text(
                        "UPDATE "
                        + table
                        + " SET "
                        + field
                        + "=:value WHERE "
                        + " AND ".join(k + "=:" + k for k in primary)
                    )
                    if is_json:
                        statement = statement.bindparams(
                            sa.bindparam("value", type_=sa.JSON())
                        )
                    db.execute(
                        statement, {**{k: row[k] for k in primary}, "value": encrypted}
                    )


def downgrade():
    raise RuntimeError(
        "Security migration cannot downgrade to plaintext; restore a verified backup with its key"
    )
