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

router = APIRouter(prefix="/api/v1/rooms", tags=["rooms"])


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


@router.post("")
def create_public_room(
    data: CreateRoomIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create a public multi-player room. Others can join via /public list or code."""
    if data.game_slug not in ("ludo", "dice", "chess"):
        raise HTTPException(status_code=400, detail="Invalid game")
    if data.max_players < 2 or data.max_players > 4:
        raise HTTPException(status_code=400, detail="max_players must be 2-4")
    if data.game_slug == "dice" and data.max_players != 2:
        raise HTTPException(status_code=400, detail="Dice is 2-player only")
    if data.game_slug == "chess" and data.max_players != 2:
        raise HTTPException(status_code=400, detail="Chess is 2-player only")

    code = _generate_code()
    while db.query(Room).filter(Room.code == code).first():
        code = _generate_code()

    room = Room(
        game_slug=data.game_slug,
        status="waiting",
        wager=0,
        created_by=me.id,
        code=code,
        is_public=True,
        max_players=data.max_players,
    )
    db.add(room)
    db.flush()
    db.add(RoomMember(room_id=room.id, user_id=me.id))
    db.commit()
    db.refresh(room)

    return {"id": room.id, "code": room.code, "game_slug": room.game_slug}


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


@router.post("/join/{code}")
def join_public_room(
    code: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Join a public room by code."""
    room = db.query(Room).filter(Room.code == code, Room.is_public.is_(True)).first()
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
        return {"id": room.id, "code": room.code}

    count = db.query(RoomMember).filter(RoomMember.room_id == room.id).count()
    if count >= (room.max_players or 4):
        raise HTTPException(status_code=400, detail="Room is full")

    db.add(RoomMember(room_id=room.id, user_id=me.id))
    db.commit()
    return {"id": room.id, "code": room.code}


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