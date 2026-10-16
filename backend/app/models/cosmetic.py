from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class UserCosmetic(Base):
    """Which cosmetics a user owns and which one is equipped."""

    __tablename__ = "user_cosmetics"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    item_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    equipped: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    purchased_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )