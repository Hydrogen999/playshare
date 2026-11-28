
"""Redis-backed presence + reconnect token service for rooms."""

import secrets
from datetime import datetime, timezone

from sqlalchemy.orm import Session

from app.models.presence import RoomPresence
from app.redis_client import get_redis

GRACE_SECONDS = 90       # how long a disconnected player can reconnect
HEARTBEAT_SECONDS = 30   # client should ping at least this often


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _key(room_id: str, user_id: str) -> str:
    return f"playsphere:presence:{room_id}:{user_id}"


def get_or_create_token(db: Session, room_id: str, user_id: str) -> str:
    """Ensure a row exists and return its reconnect token."""
    row = (
        db.query(RoomPresence)
        .filter(
            RoomPresence.room_id == room_id,
            RoomPresence.user_id == user_id,
        )
        .first()
    )
    if not row:
        row = RoomPresence(
            room_id=room_id,
            user_id=user_id,
            reconnect_token=secrets.token_urlsafe(32),
            online=True,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row.reconnect_token


def validate_token(db: Session, room_id: str, user_id: str, token: str) -> bool:
    if not token:
        return False
    row = (
        db.query(RoomPresence)
        .filter(
            RoomPresence.room_id == room_id,
            RoomPresence.user_id == user_id,
            RoomPresence.reconnect_token == token,
        )
        .first()
    )
    return row is not None


async def mark_online(db: Session, room_id: str, user_id: str, token: str | None = None):
    row = (
        db.query(RoomPresence)
        .filter(
            RoomPresence.room_id == room_id,
            RoomPresence.user_id == user_id,
        )
        .first()
    )
    if not row:
        row = RoomPresence(
            room_id=room_id,
            user_id=user_id,
            reconnect_token=token or secrets.token_urlsafe(32),
            online=True,
        )
        db.add(row)
    else:
        row.online = True
        row.disconnected_at = None
        row.last_seen_at = _now()
        if token:
            row.reconnect_token = token
    db.commit()

    # Redis presence marker with TTL for fast checks
    try:
        r = get_redis()
        await r.set(
            _key(room_id, user_id),
            "1",
            ex=GRACE_SECONDS,
        )
    except Exception as e:
        print(f"[presence] redis mark_online error: {e}")


async def mark_offline(db: Session, room_id: str, user_id: str):
    row = (
        db.query(RoomPresence)
        .filter(
            RoomPresence.room_id == room_id,
            RoomPresence.user_id == user_id,
        )
        .first()
    )
    if row:
        row.online = False
        row.disconnected_at = _now()
        db.commit()

    try:
        r = get_redis()
        await r.delete(_key(room_id, user_id))
    except Exception as e:
        print(f"[presence] redis mark_offline error: {e}")


async def is_online(room_id: str, user_id: str) -> bool:
    try:
        r = get_redis()
        return bool(await r.exists(_key(room_id, user_id)))
    except Exception:
        return False
