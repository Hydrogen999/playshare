"""Extra public fields attached to user summaries everywhere:
avatar_url (profile photo) and is_verified (blue tick)."""

from __future__ import annotations

from sqlalchemy.orm import Session

from app.models.safety import UserPhoto
from app.models.verification import VerificationApplication


def photos_bulk(db: Session, ids: list[str]) -> dict[str, str]:
    if not ids:
        return {}
    return {r.user_id: r.url for r in db.query(UserPhoto).filter(UserPhoto.user_id.in_(ids)).all()}


def verified_bulk(db: Session, ids: list[str]) -> set[str]:
    """Verified = has an APPROVED application. Revoking changes the status, so
    the tick disappears everywhere immediately. No other code path can set it."""
    if not ids:
        return set()
    rows = db.query(VerificationApplication.user_id).filter(
        VerificationApplication.user_id.in_(ids), VerificationApplication.status == "approved").all()
    return {r[0] for r in rows}


def extras(db: Session, ids: list[str]) -> dict[str, dict]:
    ids = list(set(ids))
    photos = photos_bulk(db, ids)
    verified = verified_bulk(db, ids)
    return {i: {"avatar_url": photos.get(i), "is_verified": i in verified} for i in ids}
