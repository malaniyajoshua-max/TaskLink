import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import JSONResponse
from ..deps import current_user, repository
from ..schemas import (
    AuthOut,
    LoginIn,
    PasswordResetCompleteIn,
    PasswordResetCompleteOut,
    PasswordResetRequestIn,
    PasswordResetRequestOut,
    RegistrationVerificationRequestIn,
    RegistrationVerificationRequestOut,
    RefreshIn,
    RegisterIn,
    UserOut,
)
from ..mailer import send_password_reset, send_registration_verification
from ..domain import DomainError
from ..services import AuthService, user_out

router = APIRouter(prefix="/auth", tags=["auth"])
logger = logging.getLogger(__name__)


def deliver_password_reset(email: str, nickname: str, code: str):
    """Keep delivery failures out of the public response and sensitive logs."""
    try:
        send_password_reset(email, nickname, code)
    except Exception:
        logger.error("Password reset email delivery failed")


def deliver_registration_verification(email: str, code: str):
    try:
        send_registration_verification(email, code)
    except Exception:
        logger.error("Registration verification email delivery failed")


def domain_response(request: Request, error: DomainError):
    return JSONResponse(
        status_code=error.status,
        content={
            "code": error.code,
            "message": error.message,
            "request_id": request.state.request_id,
        },
    )


@router.post("/register", response_model=AuthOut, status_code=201)
def register(body: RegisterIn, request: Request, repo=Depends(repository)):
    result = AuthService(repo).register(body)
    return (
        domain_response(request, result) if isinstance(result, DomainError) else result
    )


@router.post(
    "/register/code",
    response_model=RegistrationVerificationRequestOut,
    status_code=202,
)
def registration_email_code(
    body: RegistrationVerificationRequestIn,
    background: BackgroundTasks,
    repo=Depends(repository),
):
    result, code = AuthService(repo).request_registration_verification(body.email)
    if code:
        background.add_task(
            deliver_registration_verification, str(body.email).lower(), code
        )
    return result


@router.post("/login", response_model=AuthOut)
def login(body: LoginIn, repo=Depends(repository)):
    return AuthService(repo).login(body)


@router.post(
    "/password/forgot", response_model=PasswordResetRequestOut, status_code=202
)
def forgot_password(
    body: PasswordResetRequestIn,
    background: BackgroundTasks,
    repo=Depends(repository),
):
    result, user, code = AuthService(repo).request_password_reset(body.email)
    if user and code:
        background.add_task(deliver_password_reset, user.email, user.name, code)
    return result


@router.post("/password/reset", response_model=PasswordResetCompleteOut)
def reset_password(
    body: PasswordResetCompleteIn, request: Request, repo=Depends(repository)
):
    error = AuthService(repo).complete_password_reset(body)
    if error:
        return domain_response(request, error)
    return {"reset": True}


@router.post("/refresh", response_model=AuthOut)
def refresh(body: RefreshIn, repo=Depends(repository)):
    return AuthService(repo).refresh(body.refresh_token)


@router.post("/logout", status_code=204)
def logout(body: RefreshIn, repo=Depends(repository)):
    AuthService(repo).logout(body.refresh_token)


@router.get("/me", response_model=UserOut)
def me(user=Depends(current_user)):
    return user_out(user)
