from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.tournament import (
    create_tournament, detail, join_tournament, leave_tournament,
    list_open, my_tournaments,
)

router = APIRouter(prefix="/api/v1/tournaments", tags=["tournaments"])


class CreateIn(BaseModel):
    name: str = Field(default="Ludo Tournament", max_length=60)
    entry_fee: int = 100
    max_players: int = 8


@router.get("")
def list_all(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return {"tournaments": list_open(db)}


@router.get("/mine")
def list_mine(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return {"tournaments": my_tournaments(db, me.id)}


@router.post("")
def create(
    data: CreateIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = create_tournament(db, me.id, data.name, data.entry_fee, data.max_players)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/{tournament_id}")
def get_detail(
    tournament_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    d = detail(db, tournament_id, me.id)
    if not d:
        raise HTTPException(status_code=404, detail="Not found")
    return d


@router.post("/{tournament_id}/join")
def join(
    tournament_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = join_tournament(db, tournament_id, me.id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.post("/{tournament_id}/leave")
def leave(
    tournament_id: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = leave_tournament(db, tournament_id, me.id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result