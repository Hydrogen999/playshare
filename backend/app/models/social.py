import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Friendship(Base):
    __tablename__ = "friendships"
    __table_args__ = (
        UniqueConstraint("requester_id", "addressee_id", name="uq_friend_pair"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    requester_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    addressee_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    
    streak_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_streak_date: Mapped[str | None] = mapped_column(String(10), nullable=True)
    
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class DirectMessage(Base):
    __tablename__ = "direct_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    sender_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    recipient_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    media_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    reply_to_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reply_to_status_id: Mapped[str | None] = mapped_column(String(36), nullable=True) # <-- MUST BE HERE
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    type: Mapped[str] = mapped_column(String(32), nullable=False)
    payload: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class Status(Base):
    __tablename__ = "statuses"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    game_invite: Mapped[str | None] = mapped_column(String(32), nullable=True)
    media_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


# --- THIS WAS MISSING ---
class StatusView(Base):
    __tablename__ = "status_views"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    status_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    viewer_id: Mapped[str] = mapped_column(String(36), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
