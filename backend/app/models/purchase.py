import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Purchase(Base):
    """Record of a PlayCoin purchase via Paystack."""

    __tablename__ = "purchases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), index=True, nullable=False)
    reference: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    pack_id: Mapped[str] = mapped_column(String(32), nullable=False)
    coins: Mapped[int] = mapped_column(Integer, nullable=False)
    amount_kobo: Mapped[int] = mapped_column(Integer, nullable=False)  # smallest currency unit
    currency: Mapped[str] = mapped_column(String(8), default="NGN", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", nullable=False)  # pending | paid | failed
    paystack_ref: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=_now, nullable=False
    )
    paid_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )