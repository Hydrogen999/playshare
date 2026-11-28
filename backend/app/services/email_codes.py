import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.config import settings
from app.models.email_code import EmailCode
from app.services.mailer import mail_configured, send_email

CODE_MINUTES = 10
MAX_ATTEMPTS = 5


def _hash(code: str) -> str:
    return hashlib.sha256(f"{code}:{settings.SECRET_KEY}".encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def issue_code(db: Session, email: str, purpose: str) -> None:
    """Create a 6-digit code, email it, and rate-limit abuse."""
    email = email.lower().strip()
    now = _now()
    recent = (
        db.query(EmailCode)
        .filter(EmailCode.email == email, EmailCode.purpose == purpose)
        .order_by(EmailCode.created_at.desc())
        .limit(6)
        .all()
    )
    if recent and (now - _aware(recent[0].created_at)).total_seconds() < 60:
        raise HTTPException(status_code=429, detail="Please wait a minute before asking for another code")
    last_hour = [r for r in recent if (now - _aware(r.created_at)).total_seconds() < 3600]
    if len(last_hour) >= 5:
        raise HTTPException(status_code=429, detail="Too many codes requested. Try again in an hour.")

    if not mail_configured():
        raise HTTPException(status_code=503, detail="Email codes are not available right now")

    code = f"{secrets.randbelow(1_000_000):06d}"
    db.add(EmailCode(
        email=email, purpose=purpose, code_hash=_hash(code),
        expires_at=now + timedelta(minutes=CODE_MINUTES),
    ))
    db.commit()

    title = "Verify your email" if purpose == "signup" else "Reset your password"
    html = (
        f"<div style='font-family:Arial,sans-serif;max-width:420px;margin:auto'>"
        f"<h2 style='color:#0F766E'>Zuno Chat</h2><p>{title}. Your code is:</p>"
        f"<p style='font-size:34px;font-weight:700;letter-spacing:6px'>{code}</p>"
        f"<p style='color:#666'>It expires in {CODE_MINUTES} minutes. "
        f"If you did not ask for this, you can ignore this email.</p></div>"
    )
    if not send_email(email, f"{code} is your Zuno Chat code", html, f"Your Zuno Chat code is {code}"):
        raise HTTPException(status_code=503, detail="We could not send the email. Please try again.")


def check_code(db: Session, email: str, purpose: str, code: str) -> bool:
    """True if the code is right. A code works once, for 10 minutes, 5 tries."""
    email = email.lower().strip()
    row = (
        db.query(EmailCode)
        .filter(EmailCode.email == email, EmailCode.purpose == purpose, EmailCode.used.is_(False))
        .order_by(EmailCode.created_at.desc())
        .first()
    )
    if not row or _aware(row.expires_at) < _now() or row.attempts >= MAX_ATTEMPTS:
        return False
    if not hmac.compare_digest(row.code_hash, _hash(code.strip())):
        row.attempts += 1
        db.commit()
        return False
    row.used = True
    db.commit()
    return True
