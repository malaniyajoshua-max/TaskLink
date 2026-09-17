from fastapi import APIRouter, Depends
from ..deps import current_user, repository
from ..schemas import (
    DecisionIn,
    FriendIn,
    InviteIn,
    MessageIn,
    RoleIn,
    WorkspaceIn,
    WorkspaceOut,
)
from ..schemas import (
    StatusOut,
    InviteCreatedOut,
    MemberOut,
    InvitationOut,
    FriendOut,
    MessageOut,
    NotificationOut,
)
from ..services import CollaborationService

router = APIRouter(tags=["collaboration"])


def service(user=Depends(current_user), repo=Depends(repository)):
    return CollaborationService(repo, user)


@router.get("/workspaces", response_model=list[WorkspaceOut])
def workspaces(s=Depends(service)):
    return s.workspaces()


@router.post("/workspaces", response_model=WorkspaceOut, status_code=201)
def create_workspace(body: WorkspaceIn, s=Depends(service)):
    return s.create_workspace(body)


@router.patch("/workspaces/{workspace_id}", response_model=WorkspaceOut)
def update_workspace(workspace_id: str, body: WorkspaceIn, s=Depends(service)):
    return s.update_workspace(workspace_id, body)


@router.get("/workspaces/{workspace_id}/members", response_model=list[MemberOut])
def members(workspace_id: str, s=Depends(service)):
    return s.members(workspace_id)


@router.post(
    "/workspaces/{workspace_id}/invites",
    status_code=201,
    response_model=InviteCreatedOut,
)
def invite(workspace_id: str, body: InviteIn, s=Depends(service)):
    return s.invite(workspace_id, body)


@router.get("/invitations", response_model=list[InvitationOut])
def invitations(s=Depends(service)):
    return s.invitations()


@router.post("/invitations/{invitation_id}/decision", response_model=StatusOut)
def decide(invitation_id: str, body: DecisionIn, s=Depends(service)):
    return s.decide_invite(invitation_id, body.accept)


@router.patch("/workspaces/{workspace_id}/members/{user_id}", response_model=StatusOut)
def role(workspace_id: str, user_id: str, body: RoleIn, s=Depends(service)):
    return s.change_member(workspace_id, user_id, body.role)


@router.delete("/workspaces/{workspace_id}/members/{user_id}", response_model=StatusOut)
def remove_member(workspace_id: str, user_id: str, s=Depends(service)):
    return s.change_member(workspace_id, user_id)


@router.get("/friends", response_model=list[FriendOut])
def friends(s=Depends(service)):
    return s.friends()


@router.post("/friends", status_code=201, response_model=FriendOut)
def add_friend(body: FriendIn, s=Depends(service)):
    return s.add_friend(body)


@router.post("/friends/{friendship_id}/decision", response_model=FriendOut)
def decide_friend(friendship_id: str, body: DecisionIn, s=Depends(service)):
    return s.decide_friend(friendship_id, body.accept)


@router.delete("/friends/{friendship_id}", response_model=StatusOut)
def remove_friend(friendship_id: str, s=Depends(service)):
    return s.remove_friend(friendship_id)


@router.get("/messages/{peer_id}", response_model=list[MessageOut])
def messages(peer_id: str, s=Depends(service)):
    return s.messages(peer_id)


@router.post("/messages", status_code=201, response_model=MessageOut)
def send(body: MessageIn, s=Depends(service)):
    return s.send(body)


@router.get("/notifications", response_model=list[NotificationOut])
def notifications(s=Depends(service)):
    return s.notifications()


@router.post("/notifications/{notification_id}/read", response_model=NotificationOut)
def read_notification(notification_id: str, s=Depends(service)):
    return s.read_notification(notification_id)
