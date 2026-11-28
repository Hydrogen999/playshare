from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.match import Match
from app.models.room import Room, RoomMember
from app.models.user import User

router = APIRouter(prefix="/api/v1/matches", tags=["matches"])


class MatchOut(BaseModel):
    id: str
    room_id: str
    game_slug: str
    status: str
    wager: int
    player_a: str
    player_b: str
    roll_a: int | None
    roll_b: int | None
    winner_id: str | None
    result: str | None


class SetWagerIn(BaseModel):
    wager: int


@router.get("/{match_id}", response_model=MatchOut)
def get_match(
    match_id: str,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    m = db.get(Match, match_id)
    if not m:
        raise HTTPException(status_code=404, detail="Match not found")
    if me.id not in (m.player_a, m.player_b):
        raise HTTPException(status_code=403, detail="Not your match")
    return MatchOut(
        id=m.id,
        room_id=m.room_id,
        game_slug=m.game_slug,
        status=m.status,
        wager=m.wager,
        player_a=m.player_a,
        player_b=m.player_b,
        roll_a=m.roll_a,
        roll_b=m.roll_b,
        winner_id=m.winner_id,
        result=m.result,
    )


@router.post("/room/{room_id}/wager", response_model=MatchOut)
def set_room_wager(
    room_id: str,
    data: SetWagerIn,
    db: Session = Depends(get_db),
    me: User = Depends(get_current_user),
):
    """Set the wager on the current pending match in a room."""
    if data.wager < 0 or data.wager > 10000:
        raise HTTPException(status_code=400, detail="Invalid wager")

    room = db.get(Room, room_id)
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    members = db.query(RoomMember).filter(RoomMember.room_id == room_id).all()
    member_ids = {m.user_id for m in members}
    if me.id not in member_ids:
        raise HTTPException(status_code=403, detail="Not a member")

    match = (
        db.query(Match)
        .filter(Match.room_id == room_id, Match.status == "pending")
        .first()
    )
    if not match:
        raise HTTPException(status_code=404, detail="No pending match in this room")

    match.wager = data.wager
    room.wager = data.wager
    db.commit()
    db.refresh(match)

    return MatchOut(
        id=match.id,
        room_id=match.room_id,
        game_slug=match.game_slug,
        status=match.status,
        wager=match.wager,
        player_a=match.player_a,
        player_b=match.player_b,
        roll_a=match.roll_a,
        roll_b=match.roll_b,
        winner_id=match.winner_id,
        result=match.result,
    )