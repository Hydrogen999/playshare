import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    room_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    game_slug: Mapped[str] = mapped_column(String(32), default="dice", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    wager: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    player_a: Mapped[str] = mapped_column(String(36), nullable=False)
    player_b: Mapped[str] = mapped_column(String(36), nullable=False)

    # dice game
    roll_a: Mapped[int | None] = mapped_column(Integer, nullable=True)
    roll_b: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # ludo game — full state stored as JSON
    state_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    winner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result: Mapped[str | None] = mapped_column(String(16), nullable=True)
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )