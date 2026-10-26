from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import Profile, User
from app.schemas.auth import LoginIn, RegisterIn, TokenOut
from app.schemas.user import MeOut, ProfileOut
from app.security import create_access_token, hash_password, verify_password
from app.services.cosmetics import get_frame_style
from app.services.premium import premium_status
from app.services.referral import apply_referral

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _me_payload(db: Session, user: User) -> MeOut:
    p = user.profile
    prem = premium_status(db, user.id)
    
    # Safely handle if chat_retention_days isn't in DB yet
    retention = getattr(p, "chat_retention_days", 1) 

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
            frame_color=get_frame_style(db, user.id),
            is_premium=prem["active"],
            premium_expires_at=prem.get("expires_at"),
            chat_retention_days=retention,
        ),
    )


@router.post("/register", response_model=TokenOut)
def register(data: RegisterIn, db: Session = Depends(get_db)):
    existing = (
        db.query(User)
        .filter(or_(User.email == data.email.lower(), User.username == data.username))
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Email or username already taken")

    user = User(
        email=data.email.lower(),
        username=data.username,
        password_hash=hash_password(data.password),
    )
    user.profile = Profile()
    db.add(user)
    db.commit()
    db.refresh(user)

    if data.ref_code:
        try:
            apply_referral(db, user.id, data.ref_code)
        except Exception as e:
            print(f"[register referral error] {e}")

    token = create_access_token(sub=user.id)
    return TokenOut(access_token=token)


@router.post("/login", response_model=TokenOut)
def login(data: LoginIn, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == data.email.lower()).first()
    if not user or not verify_password(data.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user.is_banned:
        raise HTTPException(status_code=403, detail="Account banned")

    token = create_access_token(sub=user.id)
    return TokenOut(access_token=token)


@router.get("/me", response_model=MeOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return _me_payload(db, user)
