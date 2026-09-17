from alembic import context
from app.db import Base, engine
from app import models

config = context.config


def include_object(obj, name, type_, reflected, compare_to):
    # SQLite cannot add this table constraint without rebuilding the users
    # table while it is referenced by existing foreign keys. Migration 0004
    # installs equivalent INSERT/UPDATE triggers instead. Keep the constraint
    # in model metadata for PostgreSQL, but do not report the SQLite trigger
    # implementation as schema drift.
    if (
        engine.dialect.name == "sqlite"
        and type_ == "check_constraint"
        and name == "ck_users_account_id_required"
    ):
        return False
    return True


if context.is_offline_mode():
    context.configure(
        url=str(engine.url),
        target_metadata=Base.metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        include_object=include_object,
    )
    with context.begin_transaction():
        context.run_migrations()
else:
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            compare_type=True,
            include_object=include_object,
        )
        with context.begin_transaction():
            context.run_migrations()
