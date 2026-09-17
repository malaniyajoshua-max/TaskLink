"""Database unit of work. SQLite serializes transactions; PostgreSQL locks the change clock."""

from collections.abc import Generator
from contextlib import contextmanager
import os
from pathlib import Path
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DEFAULT_DB = Path(__file__).resolve().parents[1] / "data" / "tasklink.db"
DATABASE_URL = os.environ.get(
    "TASKLINK_DATABASE_URL", f"sqlite:///{DEFAULT_DB.as_posix()}"
)
if DATABASE_URL.startswith("sqlite"):
    DEFAULT_DB.parent.mkdir(parents=True, exist_ok=True)
engine = create_engine(
    DATABASE_URL,
    connect_args=(
        {"check_same_thread": False, "timeout": 30}
        if DATABASE_URL.startswith("sqlite")
        else {}
    ),
    pool_pre_ping=True,
    hide_parameters=True,
)

if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def sqlite_connect(connection, record):
        connection.isolation_level = None
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA secure_delete=ON")

    @event.listens_for(engine, "begin")
    def sqlite_begin(connection):
        connection.exec_driver_sql("BEGIN IMMEDIATE")


class Base(DeclarativeBase):
    pass


SessionLocal = sessionmaker(engine, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    with SessionLocal.begin() as session:
        yield session


def init_db():
    """Run immutable Alembic migrations, never create_all against a live database."""
    from alembic.config import Config
    from alembic import command

    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    from sqlalchemy import inspect

    clear_legacy_pages = DATABASE_URL.startswith("sqlite") and not inspect(
        engine
    ).has_table("content_key_check")
    command.upgrade(config, "head")
    if clear_legacy_pages:
        # Discard plaintext from SQLite's freelist and old WAL frames after the
        # encryption transaction commits. Backups made before this upgrade must
        # be handled separately by the operator; they are never silently deleted.
        raw = engine.raw_connection()
        try:
            raw.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            raw.execute("VACUUM")
            raw.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            raw.close()
