"""Verified Account business logic (synchronous SQLAlchemy, like the rest of the app)."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models.social import Notification
from app.models.user import User
from app.models.verification import (
    VerificationApplication as App,
    VerificationAuditLog,
    VerificationDocument as Doc,
    VerificationPayment as Pay,
    VerificationReview,
)
from app.services import verification_payments as fp
from app.services import verification_rules as rules


class VerificationError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _audit(db: Session, actor_id, action: str, application_id=None, **meta) -> None:
    db.add(VerificationAuditLog(actor_id=actor_id, action=action, application_id=application_id, meta=meta))


def _notify(db: Session, user_id: str, kind: str, message: str) -> None:
    """In-app notification (shows in the existing notifications list)."""
    try:
        db.add(Notification(user_id=user_id, type="verification",
                            payload=json.dumps({"kind": kind, "message": message})))
        db.commit()
    except Exception:
        db.rollback()   # a notification problem must never undo a decision


def _docs(db: Session, app_id: str) -> list[Doc]:
    return list(db.query(Doc).filter(Doc.application_id == app_id, Doc.deleted_at.is_(None)).order_by(Doc.created_at).all())


def _payment(db: Session, app_id: str) -> Pay | None:
    return db.query(Pay).filter(Pay.application_id == app_id).order_by(Pay.created_at.desc()).first()


def _public(db: Session, a: App) -> dict:
    p = _payment(db, a.id)
    return {
        "id": a.id, "status": a.status, "full_name": a.full_name, "username": a.username,
        "category": a.category, "reason": a.reason, "website": a.website,
        "social_links": a.social_links or [], "notes": a.notes,
        "rejection_reason": a.rejection_reason, "info_request": a.info_request,
        "payment_status": p.status if p else None,
        "documents": [{"id": d.id, "name": d.original_name, "mime": d.mime, "size": d.size} for d in _docs(db, a.id)],
        "created_at": a.created_at.isoformat(), "updated_at": a.updated_at.isoformat(),
    }


def _owned(db: Session, user_id: str, app_id: str, *, lock: bool = False) -> App:
    q = db.query(App).filter(App.id == app_id, App.user_id == user_id)
    if lock:
        q = q.with_for_update()
    a = q.first()
    if not a:   # same answer for "missing" and "someone else's": no probing
        raise VerificationError(404, "Application not found.")
    return a


# ---------------------------------------------------------------- user side
def get_status(db: Session, user_id: str) -> dict:
    apps = db.query(App).filter(App.user_id == user_id).order_by(App.created_at.desc()).all()
    current = apps[0] if apps else None
    active = next((a for a in apps if a.status in rules.ACTIVE_STATUSES), None)
    return {
        "status": current.status if current else "not_applied",
        "fee_cents": rules.FEE_CENTS, "currency": rules.FEE_CURRENCY,
        "can_apply": active is None, "payments_enabled": fp.configured(),
        "application": _public(db, current) if current else None,
        "history": [{"id": a.id, "status": a.status, "created_at": a.created_at.isoformat(),
                     "decided_at": a.decided_at.isoformat() if a.decided_at else None,
                     "rejection_reason": a.rejection_reason} for a in apps],
    }


def save_application(db: Session, user: User, raw: dict) -> dict:
    try:
        v = rules.validate_application(raw)
    except ValueError as e:
        raise VerificationError(422, str(e)) from None
    if v.username.lower() != user.username.lower():
        raise VerificationError(422, "You can only apply for your own account.")

    active = db.query(App).filter(App.user_id == user.id, App.status.in_(rules.ACTIVE_STATUSES)).with_for_update().first()
    if active:
        if active.status not in rules.EDITABLE_STATUSES:
            raise VerificationError(409, "You already have an application in progress.")
        a = active
    else:
        a = App(user_id=user.id, status=rules.PAYMENT_PENDING, full_name=v.full_name, username=v.username,
                category=v.category, reason=v.reason)
        db.add(a)
    a.full_name, a.username, a.category = v.full_name, v.username, v.category
    a.reason, a.website, a.notes = v.reason, v.website, v.notes
    a.social_links = list(v.social_links)
    try:
        db.flush()
        _audit(db, user.id, "application_saved", a.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise VerificationError(409, "You already have an application in progress.") from None
    return _public(db, a)


def add_document(db: Session, user_id: str, app_id: str, filename: str, data: bytes) -> dict:
    a = _owned(db, user_id, app_id, lock=True)
    if a.status not in rules.EDITABLE_STATUSES:
        raise VerificationError(409, "Documents can't be changed right now.")
    if not data:
        raise VerificationError(422, "The file is empty.")
    if len(data) > rules.MAX_DOC_BYTES:
        raise VerificationError(413, "File is too large (max 8 MB).")
    mime = rules.sniff_mime(data)
    if mime is None:
        raise VerificationError(415, "Only JPG, PNG, WEBP or PDF files are accepted.")
    if len(_docs(db, a.id)) >= rules.MAX_DOCS_PER_APPLICATION:
        raise VerificationError(409, f"You can upload up to {rules.MAX_DOCS_PER_APPLICATION} files.")
    db.add(Doc(application_id=a.id, original_name=os.path.basename(filename or "")[:200], mime=mime,
               size=len(data), sha256=rules.sha256_hex(data), data=data))
    _audit(db, user_id, "document_uploaded", a.id, mime=mime, size=len(data))
    db.commit()
    return _public(db, a)


def delete_document(db: Session, user_id: str, app_id: str, doc_id: str) -> dict:
    a = _owned(db, user_id, app_id, lock=True)
    if a.status not in rules.EDITABLE_STATUSES:
        raise VerificationError(409, "Documents can't be changed right now.")
    d = db.query(Doc).filter(Doc.id == doc_id, Doc.application_id == a.id, Doc.deleted_at.is_(None)).first()
    if not d:
        raise VerificationError(404, "File not found.")
    d.deleted_at, d.data = _now(), None
    _audit(db, user_id, "document_deleted", a.id)
    db.commit()
    return _public(db, a)


def start_payment(db: Session, user: User, app_id: str) -> dict:
    a = _owned(db, user.id, app_id, lock=True)
    if a.status != rules.PAYMENT_PENDING:
        raise VerificationError(409, "This application does not need a payment.")
    if not _docs(db, a.id):
        raise VerificationError(422, "Upload at least one supporting document first.")
    if db.query(Pay).filter(Pay.application_id == a.id, Pay.status == "paid").first():
        raise VerificationError(409, "This application is already paid.")
    try:
        ref, url = fp.create_checkout(amount_cents=rules.FEE_CENTS, currency=rules.FEE_CURRENCY,
                                      application_id=a.id, user_id=user.id, email=user.email, name=a.full_name)
    except fp.PaymentUnavailable as e:
        raise VerificationError(503, str(e)) from None
    db.add(Pay(application_id=a.id, provider="flutterwave", provider_reference=ref,
               amount_cents=rules.FEE_CENTS, currency=rules.FEE_CURRENCY, status="pending"))
    _audit(db, user.id, "payment_started", a.id)
    db.commit()
    return {"checkout_url": url, "amount_cents": rules.FEE_CENTS, "currency": rules.FEE_CURRENCY}


def resubmit(db: Session, user_id: str, app_id: str) -> dict:
    a = _owned(db, user_id, app_id, lock=True)
    try:
        new = rules.next_status(a.status, "resubmit")
    except rules.InvalidTransition as e:
        raise VerificationError(409, str(e)) from None
    if not _docs(db, a.id):
        raise VerificationError(422, "Upload at least one supporting document.")
    a.status, a.info_request = new, None
    _audit(db, user_id, "resubmitted", a.id)
    db.commit()
    _notify(db, user_id, "under_review", "Your verification application is under review.")
    return _public(db, a)


# ------------------------------------------------- payment settlement
def settle_by_reference(db: Session, tx_ref: str, verify=None) -> str:
    """Decide a payment's fate by asking Flutterwave. Safe to call any number of
    times (webhook retries, the app's "sync" button): the result is idempotent.
    Raises fp.PaymentUnavailable on a temporary Flutterwave problem."""
    verify = verify or fp.verify_by_reference
    pay = db.query(Pay).filter(Pay.provider_reference == tx_ref).with_for_update().first()
    if not pay:
        return "unknown"
    if pay.status != "pending":
        db.rollback()
        return pay.status
    v = verify(tx_ref)
    if v is None:
        db.rollback()
        return "pending"
    app = db.query(App).filter(App.id == pay.application_id).with_for_update().first()
    result = "pending"
    state = v["status"]
    if state == "successful":
        dup_id = v["id"] and db.query(Pay).filter(Pay.flw_transaction_id == v["id"], Pay.id != pay.id).first()
        if dup_id:
            result = "mismatch"; pay.status = "mismatch"
            _audit(db, None, "payment_replayed_id", app.id)
        elif not rules.payment_matches_fee(v["amount_cents"], v["currency"]):
            result = "mismatch"; pay.status = "mismatch"
            _audit(db, None, "payment_mismatch", app.id, got_cents=v["amount_cents"], got_currency=v["currency"])
        elif db.query(Pay).filter(Pay.application_id == app.id, Pay.status == "paid", Pay.id != pay.id).first():
            # Paid twice (e.g. two checkout tabs): never advance twice; refund the extra one by hand.
            result = "duplicate_paid"; pay.status = "duplicate_paid"; pay.flw_transaction_id = v["id"] or None
            _audit(db, None, "duplicate_payment", app.id)
        else:
            result = "paid"; pay.status = "paid"; pay.flw_transaction_id = v["id"] or None
            if app.status == rules.PAYMENT_PENDING:
                app.status = rules.next_status(app.status, "payment_confirmed")
            _audit(db, None, "payment_confirmed", app.id)
    elif state in ("failed", "cancelled"):
        result = "failed"; pay.status = "failed"
        _audit(db, None, "payment_failed", app.id)
    db.commit()
    if result == "paid":
        _notify(db, app.user_id, "payment_confirmed", "Payment confirmed. Your verification application is under review.")
    elif result == "failed":
        _notify(db, app.user_id, "payment_failed", "Your verification payment was not completed.")
    return result


def sync_payment(db: Session, user_id: str, app_id: str) -> dict:
    """Called by the app after the customer comes back from checkout."""
    a = _owned(db, user_id, app_id)
    pending = db.query(Pay).filter(Pay.application_id == a.id, Pay.status == "pending").order_by(Pay.created_at.desc()).all()
    for p in pending[:3]:
        try:
            settle_by_reference(db, p.provider_reference)
        except fp.PaymentUnavailable:
            break    # the webhook (or the next sync) will finish it
    db.expire_all()
    return get_status(db, user_id)


# ---------------------------------------------------------- admin side
def admin_list(db: Session, status: str | None, limit: int = 50, offset: int = 0) -> list[dict]:
    q = db.query(App).order_by(App.created_at.desc())
    if status:
        q = q.filter(App.status == status)
    out = []
    for a in q.offset(max(offset, 0)).limit(min(max(limit, 1), 100)).all():
        p = _payment(db, a.id)
        out.append({"id": a.id, "user_id": a.user_id, "username": a.username, "full_name": a.full_name,
                    "category": a.category, "status": a.status, "payment_status": p.status if p else None,
                    "created_at": a.created_at.isoformat()})
    return out


def admin_detail(db: Session, app_id: str) -> dict:
    a = db.get(App, app_id)
    if not a:
        raise VerificationError(404, "Application not found.")
    p = _payment(db, a.id)
    d = _public(db, a)
    d["user_id"] = a.user_id
    d["payment"] = {"provider": p.provider, "reference": p.provider_reference, "status": p.status,
                    "amount_cents": p.amount_cents, "currency": p.currency} if p else None
    d["reviews"] = [{"admin_id": r.admin_id, "decision": r.decision, "reason": r.reason, "at": r.created_at.isoformat()}
                    for r in db.query(VerificationReview).filter(VerificationReview.application_id == a.id).order_by(VerificationReview.created_at).all()]
    d["audit"] = [{"actor_id": l.actor_id, "action": l.action, "at": l.created_at.isoformat()}
                  for l in db.query(VerificationAuditLog).filter(VerificationAuditLog.application_id == a.id).order_by(VerificationAuditLog.created_at).all()]
    return d


def admin_document(db: Session, admin_id: str, doc_id: str) -> tuple[bytes, str]:
    d = db.query(Doc).filter(Doc.id == doc_id, Doc.deleted_at.is_(None)).first()
    if not d or d.data is None:
        raise VerificationError(404, "File not found.")
    _audit(db, admin_id, "document_viewed", d.application_id, doc_id=doc_id)
    db.commit()
    return d.data, d.mime


_ADMIN_ACTIONS = {"approve", "reject", "request_info", "revoke"}


def admin_decide(db: Session, admin_id: str, app_id: str, action: str, reason: str | None = None) -> dict:
    if action not in _ADMIN_ACTIONS:
        raise VerificationError(400, "Unknown action.")
    reason = (reason or "").strip()
    if action != "approve" and len(reason) < 3:
        raise VerificationError(422, "A reason is required.")
    a = db.query(App).filter(App.id == app_id).with_for_update().first()
    if not a:
        raise VerificationError(404, "Application not found.")
    if a.user_id == admin_id:
        raise VerificationError(403, "You cannot review your own application.")
    if action == "approve":
        p = db.query(Pay).filter(Pay.application_id == a.id, Pay.status == "paid").first()
        if not p:
            raise VerificationError(409, "The verification fee has not been confirmed.")
    try:
        a.status = rules.next_status(a.status, action)
    except rules.InvalidTransition as e:
        raise VerificationError(409, str(e)) from None
    a.decided_at = _now()
    if action == "approve":
        a.rejection_reason = a.info_request = None
    elif action == "reject":
        a.rejection_reason = reason
    elif action == "request_info":
        a.info_request, a.decided_at = reason, None
    elif action == "revoke":
        a.rejection_reason = reason     # the tick disappears at once: it is derived from status == approved
    db.add(VerificationReview(application_id=a.id, admin_id=admin_id, decision=action, reason=reason or None))
    _audit(db, admin_id, f"admin_{action}", a.id, reason=reason or None)
    db.commit()
    msg = {"approve": "Congratulations! Your account is now verified.",
           "reject": f"Your verification application was not approved: {reason}",
           "request_info": f"More information is needed for your verification: {reason}",
           "revoke": "Your verified badge was removed."}[action]
    _notify(db, a.user_id, action, msg)
    return admin_detail(db, a.id)


def purge_old_documents(db: Session, older_than_days: int) -> int:
    """Delete evidence of DECIDED applications older than N days (run from a cron/maintenance task)."""
    cutoff = _now() - timedelta(days=older_than_days)
    n = 0
    q = (db.query(Doc).join(App, App.id == Doc.application_id)
         .filter(Doc.deleted_at.is_(None), App.decided_at.is_not(None), App.decided_at < cutoff,
                 App.status.in_((rules.APPROVED, rules.REJECTED, rules.REVOKED))))
    for d in q.all():
        d.data, d.deleted_at = None, _now()
        n += 1
    if n:
        _audit(db, None, "documents_purged", None, count=n, older_than_days=older_than_days)
    db.commit()
    return n
