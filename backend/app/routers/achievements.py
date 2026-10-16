from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.achievements import (
    check_and_unlock, list_catalog, unlocked_count, user_achievements,
)

router = APIRouter(prefix="/api/v1/achievements", tags=["achievements"])


@router.get("")
def my_achievements(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    items = user_achievements(db, me.id)
    unlocked = sum(1 for x in items if x["unlocked"])
    return {
        "items": items,
        "unlocked": unlocked,
        "total": len(items),
    }


@router.post("/check")
def check(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    newly = check_and_unlock(db, me.id)
    return {"newly_unlocked": newly}


@router.get("/summary")
def summary(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return {
        "unlocked": unlocked_count(db, me.id),
        "total": len(list_catalog()),
    }