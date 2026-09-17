from contextlib import asynccontextmanager
import uuid
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from . import __version__
from .db import SessionLocal
from .domain import DomainError
from .models import ChangeClock, ContentKeyCheck
from .routers import attachments, auth, collaboration, documents
from .schemas import ErrorOut
from .http_security import SecurityMiddleware, rate_windows


@asynccontextmanager
async def lifespan(app):
    # Fail visibly when the schema is uninitialized rather than claiming a healthy app.
    with SessionLocal() as db:
        if db.get(ChangeClock, 1) is None:
            raise RuntimeError("Run python -m app.migrate first")
        marker = db.get(ContentKeyCheck, 1)
        if not marker or marker.value != "TaskLink content key v1":
            raise RuntimeError(
                "Content key validation failed; restore the original key"
            )
    yield


app = FastAPI(
    title="TaskLink API",
    version=__version__,
    lifespan=lifespan,
    responses={
        400: {"model": ErrorOut},
        401: {"model": ErrorOut},
        403: {"model": ErrorOut},
        409: {"model": ErrorOut},
        422: {"model": ErrorOut},
    },
)

app.add_middleware(SecurityMiddleware)


@app.exception_handler(DomainError)
async def domain_error(request, exc):
    return JSONResponse(
        status_code=exc.status,
        content=dict(
            code=exc.code, message=exc.message, request_id=request.state.request_id
        ),
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    # Never echo request bodies, passwords or tokens into errors/logs.
    details = [
        dict(field=".".join(str(x) for x in e["loc"]), code=e["type"])
        for e in exc.errors()
    ]
    return JSONResponse(
        status_code=422,
        content=dict(
            code="validation_error",
            message="输入字段校验失败",
            details=details,
            request_id=request.state.request_id,
        ),
    )


@app.exception_handler(HTTPException)
async def http_error(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content=dict(
            code="http_error",
            message=str(exc.detail),
            request_id=request.state.request_id,
        ),
    )


@app.exception_handler(Exception)
async def unexpected_error(request, exc):
    return JSONResponse(
        status_code=500,
        content=dict(
            code="internal_error",
            message="服务暂时不可用",
            request_id=getattr(request.state, "request_id", str(uuid.uuid4())),
        ),
    )


@app.get("/health", tags=["system"])
def health():
    with SessionLocal() as db:
        ready = db.get(ChangeClock, 1) is not None
    return dict(
        status="ok" if ready else "uninitialized",
        service="tasklink-api",
        version=__version__,
    )


for router in (
    auth.router,
    *documents.routers,
    collaboration.router,
    attachments.router,
):
    app.include_router(router, prefix="/api/v1")
