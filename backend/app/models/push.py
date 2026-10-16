from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class PushSettings(Base):
    __tablename__ = "push_settings"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    on_challenge: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    on_dm: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    on_friend: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    on_tournament: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    on_achievement: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, onupdate=_now, nullable=False
    )