"""PlayCoin purchase packs + Paystack integration."""

import hmac
import hashlib
import json
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.purchase import Purchase
from app.services.ledger import grant_tokens

# Pack catalog — edit here to change prices/amounts
# amount_kobo is in kobo (1 NGN = 100 kobo)
PACKS: list[dict] = [
    {"id": "pack_500",  "coins": 500,  "amount_kobo": 150000, "label": "500 PlayCoins",  "price_label": "₦1,500"},
    {"id": "pack_1200", "coins": 1200, "amount_kobo": 300000, "label": "1,200 PlayCoins","price_label": "₦3,000"},
    {"id": "pack_3000", "coins": 3000, "amount_kobo": 650000, "label": "3,000 PlayCoins","price_label": "₦6,500"},
    {"id": "pack_8000", "coins": 8000, "amount_kobo": 1500000,"label": "8,000 PlayCoins","price_label": "₦15,000"},
]

PACKS_BY_ID = {p["id"]: p for p in PACKS}
CURRENCY = "NGN"


def list_packs() -> list[dict]:
    return PACKS


def get_pack(pack_id: str) -> dict | None:
    return PACKS_BY_ID.get(pack_id)


async def initialize_transaction(
    db: Session,
    user_id: str,
    user_email: str,
    pack_id: str,
) -> dict:
    """Create a Purchase row + ask Paystack to create a checkout session."""
    pack = get_pack(pack_id)
    if not pack:
        return {"ok": False, "error": "Invalid pack"}

    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured yet"}

    reference = f"ps_{uuid.uuid4().hex[:24]}"

    purchase = Purchase(
        user_id=user_id,
        reference=reference,
        pack_id=pack_id,
        coins=pack["coins"],
        amount_kobo=pack["amount_kobo"],
        currency=CURRENCY,
        status="pending",
    )
    db.add(purchase)
    db.commit()

    # Call Paystack
    body = {
        "email": user_email,
        "amount": pack["amount_kobo"],
        "currency": CURRENCY,
        "reference": reference,
        "callback_url": settings.PAYSTACK_CALLBACK_URL,
        "metadata": {
            "user_id": user_id,
            "pack_id": pack_id,
            "coins": pack["coins"],
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
        return {"ok": False, "error": data.get("message", "Paystack initialization failed")}

    return {
        "ok": True,
        "reference": reference,
        "authorization_url": data["data"]["authorization_url"],
        "access_code": data["data"]["access_code"],
    }


async def verify_transaction(db: Session, reference: str) -> dict:
    """Ask Paystack if the transaction succeeded, then grant coins (idempotent)."""
    if not settings.PAYSTACK_SECRET_KEY:
        return {"ok": False, "error": "Payments not configured"}

    purchase = (
        db.query(Purchase).filter(Purchase.reference == reference).first()
    )
    if not purchase:
        return {"ok": False, "error": "Unknown reference"}

    # Already paid → idempotent
    if purchase.status == "paid":
        return {"ok": True, "already_paid": True, "coins": purchase.coins}

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
        purchase.status = "failed"
        db.commit()
        return {"ok": False, "error": f"Payment not successful: {tx.get('status')}"}

    # Amount check — must match what we asked for
    if int(tx.get("amount", 0)) < purchase.amount_kobo:
        return {"ok": False, "error": "Amount mismatch — contact support"}

    # Mark paid + grant coins
    purchase.status = "paid"
    purchase.paystack_ref = tx.get("id")
    purchase.paid_at = datetime.now(timezone.utc)
    db.commit()

    try:
        grant_tokens(
            db,
            purchase.user_id,
            purchase.coins,
            reason=f"purchase_{purchase.pack_id}",
            idempotency_key=f"purchase_grant:{purchase.reference}",
        )
        db.commit()
    except Exception as e:
        return {"ok": False, "error": f"Grant failed: {e}"}

    return {"ok": True, "coins": purchase.coins, "new_balance": None}


def verify_webhook_signature(body_bytes: bytes, signature: str) -> bool:
    """Paystack sends x-paystack-signature = HMAC-SHA512(body, secret_key)."""
    if not settings.PAYSTACK_SECRET_KEY or not signature:
        return False
    expected = hmac.new(
        settings.PAYSTACK_SECRET_KEY.encode("utf-8"),
        body_bytes,
        hashlib.sha512,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)