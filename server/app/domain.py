"""Pure business rules. No SQLAlchemy or HTTP dependencies."""

from datetime import datetime, timezone


class DomainError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


def require(condition: bool, code: str, message: str, status: int = 400):
    if not condition:
        raise DomainError(code, message, status)


def now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def can_write(role):
    return role in ("owner", "admin", "member")


def can_admin(role):
    return role in ("owner", "admin")


def effective_task(body: dict, parent: dict | None):
    result = dict(body)
    if parent:
        for flag, key in (
            ("inherit_due", "due_at"),
            ("inherit_reminder", "reminder_at"),
            ("inherit_priority", "priority"),
        ):
            if body.get(flag):
                result[key] = parent.get(key)
        if parent.get("due_at") and result.get("due_at"):
            require(
                result["due_at"] <= parent["due_at"],
                "subtask_after_parent",
                "子任务截止时间不能晚于父任务",
            )
    if result.get("start_at") and result.get("due_at"):
        require(
            result["start_at"] <= result["due_at"],
            "invalid_dates",
            "开始时间不能晚于截止时间",
        )
    if result.get("reminder_at") and result.get("due_at"):
        require(
            result["reminder_at"] <= result["due_at"],
            "invalid_dates",
            "提醒不能晚于截止时间",
        )
    return result
