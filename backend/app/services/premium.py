"""Premium subscription logic + Paystack integration."""

import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.premium import PremiumSubscription
from app.models.user import User

PLANS = {
    "monthly": {
        "id": "monthly",
        "label": "Premium Monthly",
        "amount_kobo": 70000,
        "days": 30,
        "price_label": "₦700 / month",
    },
    "yearly": {
        "id": "yearly",
        "label": "Premium Yearly",
        "amount_kobo": 700000,
        "days": 365,
        "price_label": "₦7,000 / year",
        "savings": "Save ₦1,400",
    },
}

CURRENCY = "NGN"


def list_plans() -> list[dict]:
    return list(PLANS.values())


def get_plan(plan_id: str) -> dict | None:
    return PLANS.get(plan_id)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def premium_bulk(db: Session, user_ids: list[str]) -> dict[str, bool]:
    """Return {user_id: is_premium} for many users at once (efficient)."""
    if not user_ids:
        return {}
    out = {uid: False for uid in user_ids}
    try:
        now = _utcnow()
        rows = (
            db.query(PremiumSubscription)
            .filter(
                PremiumSubscription.user_id.in_(user_ids),
                PremiumSubscription.status == "active",
            )
            .all()
        )
        for r in rows:
            exp = _to_aware(r.expires_at)
            if exp and exp > now:
                out[r.user_id] = True
    except Exception as e:
        print(f"[premium_bulk error] {e}")
    return out

def _to_aware(dt: datetime | None) -> datetime | None:
    """SQLite strips tzinfo. Force UTC-aware for safe comparison."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def is_premium(db: Session, user_id: str) -> bool:
    try:
        now = _utcnow()
        row = (
            db.query(PremiumSubscription)
            .filter(
                PremiumSubscription.user_id == user_id,
                PremiumSubscription.status == "active",
            )
            .order_by(PremiumSubscription.expires_at.desc())
            .first()
        )
        if not row:
            return False
        exp = _to_aware(row.expires_at)
        if exp is None:
            return False
        return exp > now
    except Exception as e:
        print(f"[premium check error] {e}")
        return False


def premium_status(db: Session, user_id: str) -> dict:
    """Safe — never raises, even if data is weird."""
    try:
        now = _utcnow()
        row = (
            db.query(PremiumSubscription)
            .filter(
                PremiumSubscription.user_id == user_id,
                PremiumSubscription.status == "active",
            )
            .order_by(PremiumSubscription.expires_at.desc())
            .first()
        )
        if not row:
            return {"active": False, "plan": None, "expires_at": None}
        exp = _to_aware(row.expires_at)
        if exp is None or exp <= now:
            return {"active": False, "plan": None, "expires_at": None}
        return {
            "active": True,
            "plan": row.plan,
            "expires_at": exp.isoformat(),
        }
    except Exception as e:
        print(f"[premium_status error] {e}")
        return {"active": False, "plan": None, "expires_at": None}


async def initialize_subscription(
    db: Session,
    user_id: str,
    user_email: str,
    plan_id: str,
) -> dict:
    plan = get_plan(plan_id)
    if not plan:
        return {"ok": False, "error": "Invalid plan"}

    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured"}

    reference = f"psm_{uuid.uuid4().hex[:24]}"

    sub = PremiumSubscription(
        user_id=user_id,
        plan=plan_id,
        reference=reference,
        amount_kobo=plan["amount_kobo"],
        currency=CURRENCY,
        status="pending",
    )
    db.add(sub)
    db.commit()

    callback = settings.PAYSTACK_CALLBACK_URL.replace("/buy/callback", "/premium/callback")

    body = {
        "email": user_email,
        "amount": plan["amount_kobo"],
        "currency": CURRENCY,
        "reference": reference,
        "callback_url": callback,
        "metadata": {
            "user_id": user_id,
            "plan_id": plan_id,
            "type": "premium",
        },
    }
    headers = {
        "Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{settings.PAYSTACK_BASE_URL}/transaction/initialize",
                json=body,
                headers=headers,
            )
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"Paystack error: {e}"}

    if not data.get("status"):
        return {"ok": False, "error": data.get("message", "Init failed")}

    return {
        "ok": True,
        "reference": reference,
        "authorization_url": data["data"]["authorization_url"],
    }


async def verify_subscription(db: Session, reference: str) -> dict:
    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured"}

    sub = (
        db.query(PremiumSubscription)
        .filter(PremiumSubscription.reference == reference)
        .first()
    )
    if not sub:
        return {"ok": False, "error": "Unknown reference"}

    if sub.status == "active":
        exp = _to_aware(sub.expires_at)
        return {
            "ok": True,
            "already_active": True,
            "expires_at": exp.isoformat() if exp else None,
        }

    headers = {"Authorization": f"Bearer {settings.PAYSTACK_SECRET_KEY}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(
                f"{settings.PAYSTACK_BASE_URL}/transaction/verify/{reference}",
                headers=headers,
            )
            data = r.json()
    except Exception as e:
        return {"ok": False, "error": f"Verify failed: {e}"}

    if not data.get("status"):
        return {"ok": False, "error": data.get("message", "Verify failed")}

    tx = data["data"]
    if tx.get("status") != "success":
        sub.status = "expired"
        db.commit()
        return {"ok": False, "error": f"Payment not successful: {tx.get('status')}"}

    if int(tx.get("amount", 0)) < sub.amount_kobo:
        return {"ok": False, "error": "Amount mismatch"}

    plan = get_plan(sub.plan)
    days = plan["days"] if plan else 30
    now = _utcnow()
    expires = now + timedelta(days=days)

    sub.status = "active"
    sub.starts_at = now
    sub.expires_at = expires
    db.commit()

    return {
        "ok": True,
        "plan": sub.plan,
        "expires_at": expires.isoformat(),
    }