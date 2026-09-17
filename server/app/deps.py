from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session
from .db import get_db
from .domain import require
from .repositories import Repository
from .services import AuthService

bearer = HTTPBearer(auto_error=False)


def repository(db: Session = Depends(get_db, scope="function")):
    # Commit/rollback must finish BEFORE an HTTP success or rotated token is sent.
    return Repository(db)


def current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    repo: Repository = Depends(repository),
):
    require(credentials is not None, "unauthorized", "请先登录", 401)
    return AuthService(repo).current(credentials.credentials)
