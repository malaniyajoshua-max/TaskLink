from fastapi import APIRouter, Depends, Query

from ..deps import current_user, repository
from ..schemas import EntityOut, SyncPullOut, SyncPushIn, SyncPushOut
from ..services import DocumentService

tasks_router = APIRouter(prefix="/tasks", tags=["tasks"])
projects_router = APIRouter(prefix="/projects", tags=["projects"])
sync_router = APIRouter(prefix="/sync", tags=["sync"])


@tasks_router.get("", response_model=list[EntityOut])
def tasks(
    limit: int = Query(default=200, ge=1, le=500),
    after: str = Query(default="", max_length=36),
    user=Depends(current_user),
    repo=Depends(repository),
):
    return DocumentService(repo, user).list("task", limit, after)


@projects_router.get("", response_model=list[EntityOut])
def projects(
    limit: int = Query(default=200, ge=1, le=500),
    after: str = Query(default="", max_length=36),
    user=Depends(current_user),
    repo=Depends(repository),
):
    return DocumentService(repo, user).list("project", limit, after)


@sync_router.post("/push", response_model=SyncPushOut)
def push(body: SyncPushIn, user=Depends(current_user), repo=Depends(repository)):
    return DocumentService(repo, user).push(body.operations)


@sync_router.get("/pull", response_model=SyncPullOut)
def pull(
    cursor: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
    user=Depends(current_user),
    repo=Depends(repository),
):
    return DocumentService(repo, user).pull(cursor, limit)


routers = (tasks_router, projects_router, sync_router)
