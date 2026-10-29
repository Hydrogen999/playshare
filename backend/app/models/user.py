import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(
        String(255), unique=True, index=True, nullable=False
    )
    username: Mapped[str] = mapped_column(
        String(32), unique=True, index=True, nullable=False
    )
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), default="user", nullable=False)
    is_banned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )

    profile: Mapped["Profile"] = relationship(
        "Profile",
        back_populates="user",
        uselist=False,
        cascade="all, delete-orphan",
    )


class Profile(Base):
    __tablename__ = "profiles"

    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    avatar_id: Mapped[str] = mapped_column(String(32), default="default", nullable=False)
    level: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    xp: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    tokens_cached: Mapped[int] = mapped_column(Integer, default=100, nullable=False)
    elo_rating: Mapped[int] = mapped_column(Integer, default=1200, nullable=False)
    chess_games_played: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chess_wins: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chess_losses: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chess_draws: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    bio: Mapped[str] = mapped_column(Text, default="", nullable=False)
    country: Mapped[str] = mapped_column(String(2), default="", nullable=False)
    
    # 🟢 THIS IS WHERE last_seen BELONGS
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    
    # --- NEW: Chat Auto-Clear Settings ---
    chat_retention_days: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    user: Mapped[User] = relationship("User", back_populates="profile")
