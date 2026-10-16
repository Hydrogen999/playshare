from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.push import PushSettings
from app.models.user import User

router = APIRouter(prefix="/api/v1/push", tags=["push"])


class SettingsIn(BaseModel):
    enabled: bool | None = None
    on_challenge: bool | None = None
    on_dm: bool | None = None
    on_friend: bool | None = None
    on_tournament: bool | None = None
    on_achievement: bool | None = None


def _get_or_create(db: Session, user_id: str) -> PushSettings:
    row = db.get(PushSettings, user_id)
    if not row:
        row = PushSettings(user_id=user_id)
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


@router.get("/settings")
def get_settings(
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = _get_or_create(db, me.id)
    return {
        "enabled": s.enabled,
        "on_challenge": s.on_challenge,
        "on_dm": s.on_dm,
        "on_friend": s.on_friend,
        "on_tournament": s.on_tournament,
        "on_achievement": s.on_achievement,
    }


@router.post("/settings")
def update_settings(
    data: SettingsIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    s = _get_or_create(db, me.id)
    if data.enabled is not None: s.enabled = data.enabled
    if data.on_challenge is not None: s.on_challenge = data.on_challenge
    if data.on_dm is not None: s.on_dm = data.on_dm
    if data.on_friend is not None: s.on_friend = data.on_friend
    if data.on_tournament is not None: s.on_tournament = data.on_tournament
    if data.on_achievement is not None: s.on_achievement = data.on_achievement
    db.commit()
    return {"ok": True}