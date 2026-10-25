from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.avatars import is_valid_avatar
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.user import MeOut, ProfileOut, ProfileUpdateIn
from app.services.premium import premium_bulk

router = APIRouter(prefix="/api/v1/me", tags=["me"])


def _me_payload(user: User) -> MeOut:
    p = user.profile
    return MeOut(
        id=user.id,
        email=user.email,
        username=user.username,
        role=user.role,
        profile=ProfileOut(
            avatar_id=p.avatar_id,
            level=p.level,
            xp=p.xp,
            tokens=p.tokens_cached,
            bio=p.bio,
            country=p.country,
            chat_retention_days=p.chat_retention_days, # NEW
        ),
    )


@router.patch("/profile", response_model=MeOut)
def update_profile(
    data: ProfileUpdateIn,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if data.avatar_id is not None:
        if not is_valid_avatar(data.avatar_id):
            raise HTTPException(status_code=400, detail="Invalid avatar")
        user.profile.avatar_id = data.avatar_id

    if data.bio is not None:
        user.profile.bio = data.bio.strip()[:280]

    if data.country is not None:
        c = data.country.strip().upper()
        if c and len(c) != 2:
            raise HTTPException(status_code=400, detail="Country must be 2-letter code")
        user.profile.country = c

    # --- NEW: Chat Retention Update ---
    if data.chat_retention_days is not None:
        is_prem = premium_bulk(db, [user.id]).get(user.id, False)
        
        if not is_prem and data.chat_retention_days > 1:
            raise HTTPException(status_code=403, detail="Premium required to save chats for more than 1 day")
        
        if data.chat_retention_days in (1, 7, 30):
            user.profile.chat_retention_days = data.chat_retention_days
        else:
            raise HTTPException(status_code=400, detail="Invalid chat retention days")

    db.commit()
    db.refresh(user)
    return _me_payload(user)
