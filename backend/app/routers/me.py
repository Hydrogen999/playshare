from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.orm import Session

from app.avatars import is_valid_avatar
from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.user import MeOut, ProfileOut, ProfileUpdateIn
from app.services.cosmetics import get_frame_style
from app.models.safety import UserPhoto
from app.services.media import BadMedia, MAX_IMAGE, save_media
from app.services.premium import premium_status

router = APIRouter(prefix="/api/v1/me", tags=["me"])


def _me_payload(user: User, db: Session) -> MeOut:
    from app.routers.auth import _me_payload as build
    return build(db, user)


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

    if data.chat_retention_days is not None:
        prem = premium_status(db, user.id)
        if not prem["active"] and data.chat_retention_days > 1:
            raise HTTPException(status_code=403, detail="Premium required to save chats for more than 1 day")
        
        if data.chat_retention_days in (1, 7, 30):
            user.profile.chat_retention_days = data.chat_retention_days

    db.commit()
    db.refresh(user)
    return _me_payload(user, db)



@router.post("/profile/photo", response_model=MeOut)
async def upload_profile_photo(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    data = await file.read(MAX_IMAGE + 1)
    try:
        url = save_media(db, user.id, data, file.filename or "", only=("image",))
    except BadMedia as e:
        raise HTTPException(status_code=400, detail=str(e))
    row = db.get(UserPhoto, user.id)
    if row:
        row.url = url
    else:
        db.add(UserPhoto(user_id=user.id, url=url))
    db.commit()
    db.refresh(user)
    return _me_payload(user, db)


@router.delete("/profile/photo", response_model=MeOut)
def delete_profile_photo(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(UserPhoto).filter(UserPhoto.user_id == user.id).delete()
    db.commit()
    db.refresh(user)
    return _me_payload(user, db)
