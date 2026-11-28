"""Tables for blocking, reporting, privacy, birthdays, profile photos,
uploaded media and email codes.

All of these are NEW tables, so Base.metadata.create_all() creates them on the
next start-up without touching any existing table.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, LargeBinary, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserBlock(Base):
    __tablename__ = "user_blocks"

    blocker_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    blocked_id: Mapped[str] = mapped_column(String(36), primary_key=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class UserReport(Base):
    __tablename__ = "user_reports"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    reporter_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    target_type: Mapped[str] = mapped_column(String(12), nullable=False)   # user | message | status
    target_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    reported_user_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    reason: Mapped[str] = mapped_column(String(40), nullable=False)
    details: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(12), default="open", index=True, nullable=False)  # open | actioned | dismissed
    reviewed_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class UserSafety(Base):
    """Birthday and privacy choices, one row per user (created on first use)."""
    __tablename__ = "user_safety"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    birth_month: Mapped[int | None] = mapped_column(Integer, nullable=True)
    birth_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    birth_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    p_birthday: Mapped[str] = mapped_column(String(10), default="friends", nullable=False)
    p_last_seen: Mapped[str] = mapped_column(String(10), default="friends", nullable=False)
    p_online: Mapped[str] = mapped_column(String(10), default="friends", nullable=False)
    p_add: Mapped[str] = mapped_column(String(10), default="everyone", nullable=False)
    p_message: Mapped[str] = mapped_column(String(10), default="everyone", nullable=False)
    p_call: Mapped[str] = mapped_column(String(10), default="friends", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class UserPhoto(Base):
    __tablename__ = "user_photos"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    url: Mapped[str] = mapped_column(String(255), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class MediaFile(Base):
    """Uploaded images / voice notes / videos. Stored in the database so they
    survive Render restarts and redeploys (the web disk is wiped)."""
    __tablename__ = "media_files"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)          # random hex
    owner_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    mime: Mapped[str] = mapped_column(String(40), nullable=False)
    ext: Mapped[str] = mapped_column(String(8), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True, nullable=False)


class EmailCode(Base):
    __tablename__ = "email_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    purpose: Mapped[str] = mapped_column(String(12), nullable=False)       # signup | reset
    code_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
