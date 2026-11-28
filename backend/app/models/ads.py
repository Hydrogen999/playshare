import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class AdSettings(Base):
    """Global ad settings — one row (id=1)."""
    __tablename__ = "ad_settings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    banner_code: Mapped[str] = mapped_column(Text, default="", nullable=False)
    rewarded_code: Mapped[str] = mapped_column(Text, default="", nullable=False)
    rewarded_coins: Mapped[int] = mapped_column(Integer, default=10, nullable=False)
    rewarded_daily_limit: Mapped[int] = mapped_column(Integer, default=5, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )


class RewardedAdView(Base):
    __tablename__ = "rewarded_ad_views"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    coins_granted: Mapped[int] = mapped_column(Integer, nullable=False)
    viewed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, index=True, nullable=False
    )