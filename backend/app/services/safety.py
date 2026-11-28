"""Blocking, privacy and relationship rules (used by REST routes and websockets)."""

from __future__ import annotations

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models.safety import UserBlock, UserSafety
from app.models.social import Friendship
from app.services.safety_rules import PRIVACY, allowed  # noqa: F401

def get_safety(db: Session, user_id: str) -> UserSafety:
    row = db.get(UserSafety, user_id)
    if row is None:
        row = UserSafety(user_id=user_id, p_birthday="friends", p_last_seen="friends", p_online="friends",
                         p_add="everyone", p_message="everyone", p_call="friends")
        db.add(row)
        db.flush()
    return row


def peek_safety(db: Session, user_id: str) -> dict:
    """Read-only view with defaults filled in (never writes)."""
    row = db.get(UserSafety, user_id)
    out = {k: (getattr(row, col) if row else default) for k, (col, _vals, default) in PRIVACY.items()}
    out["birth_month"] = row.birth_month if row else None
    out["birth_day"] = row.birth_day if row else None
    out["birth_year"] = row.birth_year if row else None
    return out


def blocked_ids(db: Session, user_id: str) -> set[str]:
    """Everyone with a block in EITHER direction with this user."""
    rows = db.query(UserBlock).filter(or_(UserBlock.blocker_id == user_id, UserBlock.blocked_id == user_id)).all()
    out: set[str] = set()
    for r in rows:
        out.add(r.blocked_id if r.blocker_id == user_id else r.blocker_id)
    return out


def is_blocked(db: Session, a: str, b: str) -> bool:
    return db.query(UserBlock).filter(
        or_((UserBlock.blocker_id == a) & (UserBlock.blocked_id == b),
            (UserBlock.blocker_id == b) & (UserBlock.blocked_id == a))
    ).first() is not None


def is_friend(db: Session, a: str, b: str) -> bool:
    return db.query(Friendship).filter(
        Friendship.status == "accepted",
        or_((Friendship.requester_id == a) & (Friendship.addressee_id == b),
            (Friendship.requester_id == b) & (Friendship.addressee_id == a)),
    ).first() is not None


def check_interaction(db: Session, actor: str, target: str, kind: str) -> str | None:
    """Return None when allowed, else a short reason.
    kind: message | call | add."""
    if actor == target:
        return "You cannot do that to yourself."
    if is_blocked(db, actor, target):
        return "You can't interact with this user."
    s = peek_safety(db, target)
    key = {"message": "who_can_message", "call": "who_can_call", "add": "who_can_add"}[kind]
    if not allowed(s[key], is_friend(db, actor, target)):
        return {"message": "This user doesn't accept messages from you.",
                "call": "This user doesn't accept calls from you.",
                "add": "This user isn't accepting friend requests."}[kind]
    return None


def can_see(db: Session, viewer: str, owner: str, key: str) -> bool:
    """Whether `viewer` may see owner's birthday / last_seen / online_status."""
    if viewer == owner:
        return True
    if is_blocked(db, viewer, owner):
        return False
    return allowed(peek_safety(db, owner)[key], is_friend(db, viewer, owner))
