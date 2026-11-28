"""Verified Account tables (new tables only; created by create_all)."""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON, DateTime, ForeignKey, Index, Integer, LargeBinary, String, Text, text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


_ACTIVE_SQL = "status IN ('payment_pending','under_review','more_info_required','approved')"


class VerificationApplication(Base):
    __tablename__ = "verification_applications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    user_id: Mapped[str] = mapped_column(String(36), ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(120), nullable=False)
    username: Mapped[str] = mapped_column(String(32), nullable=False)
    category: Mapped[str] = mapped_column(String(30), nullable=False)
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    website: Mapped[str] = mapped_column(String(300), default="", nullable=False)
    social_links: Mapped[list] = mapped_column(JSON, default=list, nullable=False)
    notes: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default="payment_pending", index=True, nullable=False)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    info_request: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        # The database itself guarantees one active application per user.
        Index("uq_verification_one_active_per_user", "user_id", unique=True,
              postgresql_where=text(_ACTIVE_SQL), sqlite_where=text(_ACTIVE_SQL)),
    )


class VerificationPayment(Base):
    __tablename__ = "verification_payments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(String(36), ForeignKey("verification_applications.id", ondelete="CASCADE"), index=True, nullable=False)
    provider: Mapped[str] = mapped_column(String(30), nullable=False)
    provider_reference: Mapped[str] = mapped_column(String(120), unique=True, nullable=False)   # our tx_ref
    amount_cents: Mapped[int] = mapped_column(Integer, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True, nullable=False)  # pending|paid|failed|mismatch|duplicate_paid|refunded
    flw_transaction_id: Mapped[str | None] = mapped_column(String(40), unique=True, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now, nullable=False)


class VerificationDocument(Base):
    """Evidence files. Stored in the database (private; only the applicant
    uploads and only administrators can read them)."""
    __tablename__ = "verification_documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(String(36), ForeignKey("verification_applications.id", ondelete="CASCADE"), index=True, nullable=False)
    original_name: Mapped[str] = mapped_column(String(200), default="", nullable=False)
    mime: Mapped[str] = mapped_column(String(40), nullable=False)
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    data: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)   # NULL after purge
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class VerificationReview(Base):
    __tablename__ = "verification_reviews"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    application_id: Mapped[str] = mapped_column(String(36), ForeignKey("verification_applications.id", ondelete="CASCADE"), index=True, nullable=False)
    admin_id: Mapped[str] = mapped_column(String(36), nullable=False)
    decision: Mapped[str] = mapped_column(String(20), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)


class VerificationAuditLog(Base):
    __tablename__ = "verification_audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=_uuid)
    actor_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    action: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    application_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    meta: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, nullable=False)
