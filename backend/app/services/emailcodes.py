"""6-digit email codes for signup and password reset."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.config import settings
from app.models.safety import EmailCode
from app.services.mailer import send_email

CODE_TTL_MIN = 10
MAX_ATTEMPTS = 5
RESEND_GAP_SEC = 60
MAX_PER_HOUR = 5


def _hash(email: str, purpose: str, code: str) -> str:
    return hashlib.sha256(f"{settings.SECRET_KEY}|{email}|{purpose}|{code}".encode()).hexdigest()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class CodeError(Exception):
    pass


def issue_code(db: Session, email: str, purpose: str, send: bool = True) -> None:
    email = email.strip().lower()
    now = datetime.now(timezone.utc)
    recent = db.query(EmailCode).filter(EmailCode.email == email, EmailCode.created_at >= now - timedelta(hours=1)).order_by(EmailCode.created_at.desc()).all()
    if recent and (now - _aware(recent[0].created_at)).total_seconds() < RESEND_GAP_SEC:
        raise CodeError("Please wait a minute before asking for another code.")
    if len(recent) >= MAX_PER_HOUR:
        raise CodeError("Too many codes requested. Try again later.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(EmailCode(email=email, purpose=purpose, code_hash=_hash(email, purpose, code),
                     expires_at=now + timedelta(minutes=CODE_TTL_MIN)))
    db.commit()
    if send:
        what = "verify your email" if purpose == "signup" else "reset your password"
        ok = send_email(email, f"Your {settings.APP_NAME} code",
                        f"Use this code to {what}: {code}\n\nIt expires in {CODE_TTL_MIN} minutes. "
                        f"If you didn't ask for it, ignore this email.")
        if not ok:
            raise CodeError("We could not send the email right now. Please try again later.")


def check_code(db: Session, email: str, purpose: str, code: str) -> bool:
    """True once for a valid code. Wrong guesses are counted and capped."""
    email = email.strip().lower()
    now = datetime.now(timezone.utc)
    row = db.query(EmailCode).filter(EmailCode.email == email, EmailCode.purpose == purpose,
                                     EmailCode.used_at.is_(None)).order_by(EmailCode.created_at.desc()).first()
    if not row or _aware(row.expires_at) < now or row.attempts >= MAX_ATTEMPTS:
        return False
    row.attempts += 1
    ok = hmac.compare_digest(row.code_hash, _hash(email, purpose, code.strip()))
    if ok:
        row.used_at = now
    db.commit()
    return ok
