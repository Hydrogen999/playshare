from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr
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
from app.services.userextra import extras
from app.services.safety import get_safety
from app.services.safety_rules import parse_birthday
from app.services import emailcodes
from app.services.mailer import email_enabled
from app.services.ratelimit import guard

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])


def _me_payload(db: Session, user: User) -> MeOut:
    p = user.profile
    prem = premium_status(db, user.id)
    retention = getattr(p, "chat_retention_days", 1)
    ex = extras(db, [user.id])[user.id]

    return MeOut(
        id=user.id,
        email=user.email,
        username=user.username,
        role=user.role,
        is_verified=ex["is_verified"],
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
            avatar_url=ex["avatar_url"],
        ),
    )


@router.post("/register", response_model=TokenOut)
def register(data: RegisterIn, request: Request, db: Session = Depends(get_db)):
    guard(request, "register", 10, 3600)
    existing = (
        db.query(User)
        .filter(or_(User.email == data.email.lower(), User.username == data.username))
        .first()
    )
    if existing:
        raise HTTPException(status_code=400, detail="Email or username already taken")

    birth = None
    if data.date_of_birth:
        try:
            y, m, d = (int(x) for x in data.date_of_birth.split("-"))
            birth = parse_birthday(m, d, y)
        except (ValueError, TypeError) as e:
            raise HTTPException(status_code=400, detail=str(e) if str(e) else "Invalid date of birth")

    if email_enabled():
        if not data.email_code or not emailcodes.check_code(db, data.email, "signup", data.email_code):
            raise HTTPException(status_code=400, detail="Invalid or expired email code")

    user = User(
        email=data.email.lower(),
        username=data.username,
        password_hash=hash_password(data.password),
    )
    user.profile = Profile()
    db.add(user)
    db.commit()
    db.refresh(user)

    if birth:
        row = get_safety(db, user.id)
        row.birth_month, row.birth_day, row.birth_year = birth.month, birth.day, birth.year
        db.commit()

    if data.ref_code:
        try:
            apply_referral(db, user.id, data.ref_code)
        except Exception as e:
            print(f"[register referral error] {e}")

    token = create_access_token(sub=user.id)
    return TokenOut(access_token=token)


@router.post("/login", response_model=TokenOut)
def login(data: LoginIn, request: Request, db: Session = Depends(get_db)):
    guard(request, "login", 10, 600, data.email.lower())
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



# --------------------------------------------------------------- extras
@router.get("/config")
def auth_config():
    return {"email_codes": email_enabled(), "min_age": 13}


class EmailIn(BaseModel):
    email: EmailStr


@router.post("/email/send-code")
def send_signup_code(data: EmailIn, request: Request, db: Session = Depends(get_db)):
    guard(request, "sendcode", 8, 3600)
    if not email_enabled():
        raise HTTPException(status_code=503, detail="Email codes are not available.")
    if db.query(User).filter(User.email == data.email.lower()).first():
        raise HTTPException(status_code=400, detail="That email is already registered")
    try:
        emailcodes.issue_code(db, data.email, "signup")
    except emailcodes.CodeError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return {"ok": True}


@router.post("/password/forgot")
def forgot_password(data: EmailIn, request: Request, db: Session = Depends(get_db)):
    guard(request, "forgot", 8, 3600)
    if not email_enabled():
        raise HTTPException(status_code=503, detail="Password reset by email is not available yet.")
    user = db.query(User).filter(User.email == data.email.lower()).first()
    if user and not user.is_banned:
        try:
            emailcodes.issue_code(db, data.email, "reset")
        except emailcodes.CodeError:
            pass   # same answer either way, so nobody can probe which emails exist
    return {"ok": True}


class ResetIn(BaseModel):
    email: EmailStr
    code: str
    new_password: str


@router.post("/password/reset")
def reset_password(data: ResetIn, request: Request, db: Session = Depends(get_db)):
    guard(request, "reset", 10, 3600)
    if not (8 <= len(data.new_password) <= 128):
        raise HTTPException(status_code=400, detail="Password must be 8-128 characters.")
    user = db.query(User).filter(User.email == data.email.lower()).first()
    if not user or not emailcodes.check_code(db, data.email, "reset", data.code):
        raise HTTPException(status_code=400, detail="Invalid or expired code")
    user.password_hash = hash_password(data.new_password)
    db.commit()
    return {"ok": True}
