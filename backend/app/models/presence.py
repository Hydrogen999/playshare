
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class RoomPresence(Base):
    """
    Tracks which users are actively connected to a room,
    plus a reconnect token so they can resume after a drop.
    """
    __tablename__ = "room_presence"

    room_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)

    reconnect_token: Mapped[str] = mapped_column(
        String(64), default=_uuid, index=True, nullable=False
    )
    online: Mapped[bool] = mapped_column(default=True, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    disconnected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
