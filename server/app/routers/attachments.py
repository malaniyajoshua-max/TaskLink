from typing import Annotated
from fastapi import APIRouter, Body, Depends, Path, Response
from ..deps import current_user, repository
from ..attachments import AttachmentService
from ..schemas import (
    AttachmentIn,
    AttachmentOut,
    UploadOut,
    AvatarIn,
    ProfileUpdateIn,
    UserOut,
)
from ..services import CollaborationService

router = APIRouter(tags=["chat-media"])


def service(user=Depends(current_user), repo=Depends(repository)):
    return AttachmentService(repo, user)


@router.post("/attachments", response_model=UploadOut, status_code=201)
def begin(body: AttachmentIn, s=Depends(service)):
    return s.begin(body)


@router.put("/attachments/{attachment_id}/chunks/{number}", status_code=204)
def upload(
    attachment_id: str,
    number: Annotated[int, Path(ge=0, lt=100)],
    body: Annotated[
        bytes, Body(media_type="application/octet-stream", max_length=256 * 1024)
    ],
    s=Depends(service),
):
    s.chunk(attachment_id, number, body)
    return Response(status_code=204)


@router.post("/attachments/{attachment_id}/complete", response_model=AttachmentOut)
def complete(attachment_id: str, s=Depends(service)):
    return s.complete(attachment_id)


@router.get("/attachments/{attachment_id}", response_model=AttachmentOut)
def info(attachment_id: str, s=Depends(service)):
    return s.info(attachment_id)


@router.get(
    "/attachments/{attachment_id}/chunks/{number}",
    response_class=Response,
    responses={
        200: {
            "content": {
                "application/octet-stream": {
                    "schema": {"type": "string", "format": "binary"}
                }
            }
        }
    },
)
def download(
    attachment_id: str, number: Annotated[int, Path(ge=0, lt=100)], s=Depends(service)
):
    return Response(
        s.download(attachment_id, number),
        media_type="application/octet-stream",
        headers={"Content-Disposition": "attachment"},
    )


@router.get(
    "/attachments/{attachment_id}/preview",
    response_class=Response,
    responses={
        200: {
            "content": {
                "image/webp": {"schema": {"type": "string", "format": "binary"}}
            }
        }
    },
)
def preview(attachment_id: str, s=Depends(service)):
    return Response(s.preview(attachment_id), media_type="image/webp")


@router.delete("/attachments/{attachment_id}", status_code=204)
def discard(attachment_id: str, s=Depends(service)):
    s.discard(attachment_id)
    return Response(status_code=204)


@router.put("/profile/avatar", response_model=UserOut)
def avatar(body: AvatarIn, user=Depends(current_user), repo=Depends(repository)):
    return CollaborationService(repo, user).update_avatar(body)


@router.patch("/profile", response_model=UserOut)
def profile(
    body: ProfileUpdateIn, user=Depends(current_user), repo=Depends(repository)
):
    return CollaborationService(repo, user).update_profile(body)
