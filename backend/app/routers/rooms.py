import random
import string

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.room import Room, RoomMember
from app.models.user import User
from app.schemas.room import RoomMemberOut, RoomOut
from app.services import presence as presence_svc

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])

ALLOWED_GAMES = {"ludo", "dice", "chess"}


def _generate_code() -> str:
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def _room_out(db: Session, room: Room) -> RoomOut:
    members_out: list[RoomMemberOut] = []
    for m in room.members:
        u = db.get(User, m.user_id)
        if not u:
            continue
        members_out.append(
            RoomMemberOut(
                user_id=u.id,
                username=u.username,
                avatar_id=u.profile.avatar_id,
                level=u.profile.level,
                ready=m.ready,
            )
        )
    return RoomOut(
        id=room.id,
        game_slug=room.game_slug,
        status=room.status,
        wager=room.wager,
        members=members_out,
    )


class CreateRoomIn(BaseModel):
    game_slug: str = "ludo"
    max_players: int = 4
    wager: int = 0
    is_public: bool = True          # NEW — private rooms supported


# ---------------------------------------------------------------------------
# CREATE
# ---------------------------------------------------------------------------


@router.post("")
def create_public_room(
    data: CreateRoomIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Create a room. Set `is_public=false` to make a private room.
    Both public and private rooms share the same 6-char code so either can
    be joined via /join/{code}.
    """
    if data.game_slug not in ALLOWED_GAMES:
        raise HTTPException(status_code=400, detail="Invalid game")
    if data.max_players < 2 or data.max_players > 4:
        raise HTTPException(status_code=400, detail="max_players must be 2-4")
    if data.game_slug == "dice" and data.max_players != 2:
        raise HTTPException(status_code=400, detail="Dice is 2-player only")
    if data.game_slug == "chess" and data.max_players != 2:
        raise HTTPException(status_code=400, detail="Chess is 2-player only")

    # Clamp wager to a sane range
    try:
        wager = max(0, min(int(data.wager or 0), 10000))
    except (TypeError, ValueError):
        wager = 0

    # Generate unique code
    code = _generate_code()
    while db.query(Room).filter(Room.code == code).first():
        code = _generate_code()

    room = Room(
        game_slug=data.game_slug,
        status="waiting",
        wager=wager,
        created_by=me.id,
        code=code,
        is_public=bool(data.is_public),
        max_players=data.max_players,
    )
    db.add(room)
    db.flush()
    db.add(RoomMember(room_id=room.id, user_id=me.id))
    db.commit()
    db.refresh(room)

    # Issue reconnect token for the host
    token = presence_svc.get_or_create_token(db, room.id, me.id)

    return {
        "id": room.id,
        "code": room.code,
        "game_slug": room.game_slug,
        "is_public": room.is_public,
        "reconnect_token": token,
    }


# ---------------------------------------------------------------------------
# LIST
# ---------------------------------------------------------------------------


@router.get("/public")
def list_public_rooms(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """List public rooms that are still waiting for players."""
    rows = (
        db.query(Room)
        .filter(
            Room.is_public.is_(True),
            Room.status == "waiting",
        )
        .order_by(Room.created_at.desc())
        .limit(30)
        .all()
    )
    out = []
    for r in rows:
        count = db.query(RoomMember).filter(RoomMember.room_id == r.id).count()
        if count >= (r.max_players or 4):
            continue
        creator = db.get(User, r.created_by)
        out.append({
            "id": r.id,
            "code": r.code,
            "game_slug": r.game_slug,
            "max_players": r.max_players or 4,
            "player_count": count,
            "creator_username": creator.username if creator else "unknown",
        })
    return {"rooms": out}


# ---------------------------------------------------------------------------
# JOIN BY CODE  (works for BOTH public and private rooms)
# ---------------------------------------------------------------------------


@router.post("/join/{code}")
def join_public_room(
    code: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Join any room by code — public OR private.
    Private rooms are simply hidden from /public but still joinable by code.
    """
    room = db.query(Room).filter(Room.code == code).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if room.status != "waiting":
        raise HTTPException(status_code=400, detail="Room already started")

    existing = (
        db.query(RoomMember)
        .filter(RoomMember.room_id == room.id, RoomMember.user_id == me.id)
        .first()
    )
    if existing:
        token = presence_svc.get_or_create_token(db, room.id, me.id)
        return {
            "id": room.id,
            "code": room.code,
            "reconnect_token": token,
        }

    count = db.query(RoomMember).filter(RoomMember.room_id == room.id).count()
    if count >= (room.max_players or 4):
        raise HTTPException(status_code=400, detail="Room is full")

    db.add(RoomMember(room_id=room.id, user_id=me.id))
    db.commit()

    token = presence_svc.get_or_create_token(db, room.id, me.id)
    return {
        "id": room.id,
        "code": room.code,
        "reconnect_token": token,
    }


# ---------------------------------------------------------------------------
# GET SINGLE ROOM
# ---------------------------------------------------------------------------


@router.get("/{room_id}", response_model=RoomOut)
def get_room(
    room_id: str,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    room = db.get(Room, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    member_ids = {m.user_id for m in room.members}
    if me.id not in member_ids and not room.is_public:
        raise HTTPException(status_code=403, detail="Not a member")
    return _room_out(db, room)


# ---------------------------------------------------------------------------
# RECONNECT  (resume after a dropped WS)
# ---------------------------------------------------------------------------


class ReconnectIn(BaseModel):
    reconnect_token: str | None = None


@router.post("/{room_id}/reconnect")
def reconnect_room(
    room_id: str,
    body: ReconnectIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Validate a reconnect token and return room state so the client can resume.

    - If token is missing or invalid → 401 (except for first-time members: token
      is issued silently).
    - If user is not a member of the room → 403.
    - Always returns a fresh (or existing) reconnect_token.
    """
    room = db.get(Room, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    member = (
        db.query(RoomMember)
        .filter(RoomMember.room_id == room_id, RoomMember.user_id == me.id)
        .first()
    )
    if not member:
        raise HTTPException(status_code=403, detail="Not a member of this room")

    token = (body.reconnect_token or "").strip()
    if token and not presence_svc.validate_token(db, room_id, me.id, token):
        raise HTTPException(status_code=401, detail="Invalid reconnect token")

    new_token = presence_svc.get_or_create_token(db, room_id, me.id)

    return {
        "ok": True,
        "room": _room_out(db, room),
        "reconnect_token": new_token,
    }
