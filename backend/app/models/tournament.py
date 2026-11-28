import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Tournament(Base):
    __tablename__ = "tournaments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(64), nullable=False)
    creator_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    entry_fee: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    max_players: Mapped[int] = mapped_column(Integer, default=8, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="waiting", nullable=False)
    prize_pool: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    winner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class TournamentPlayer(Base):
    __tablename__ = "tournament_players"

    tournament_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    eliminated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    placement: Mapped[int | None] = mapped_column(Integer, nullable=True)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )


class TournamentMatch(Base):
    __tablename__ = "tournament_matches"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    tournament_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    round: Mapped[int] = mapped_column(Integer, nullable=False)
    position: Mapped[int] = mapped_column(Integer, nullable=False)
    player_a: Mapped[str | None] = mapped_column(String(36), nullable=True)
    player_b: Mapped[str | None] = mapped_column(String(36), nullable=True)
    room_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    winner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )