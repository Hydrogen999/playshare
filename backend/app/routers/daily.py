from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.daily import claim, get_state

router = APIRouter(prefix="/api/v1/me/daily", tags=["daily"])


@router.get("")
def daily_state(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return get_state(db, me.id)


@router.post("/claim")
def daily_claim(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return claim(db, me.id)