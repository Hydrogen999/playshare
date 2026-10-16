"""Flutterwave integration — global USD/EUR/GBP payments."""

import asyncio
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models.purchase import Purchase
from app.services.ledger import grant_tokens

# Pack catalog in USD — Flutterwave converts to local currency
USD_PACKS: list[dict] = [
    {"id": "pack_usd_500",  "coins": 500,  "amount_usd": 3.99,  "label": "500 PlayCoins",  "price_label": "$3.99"},
    {"id": "pack_usd_1200", "coins": 1200, "amount_usd": 7.99,  "label": "1,200 PlayCoins","price_label": "$7.99"},
    {"id": "pack_usd_3000", "coins": 3000, "amount_usd": 17.99, "label": "3,000 PlayCoins","price_label": "$17.99"},
    {"id": "pack_usd_8000", "coins": 8000, "amount_usd": 39.99, "label": "8,000 PlayCoins","price_label": "$39.99"},
]

USD_PACKS_BY_ID = {p["id"]: p for p in USD_PACKS}
DEFAULT_CURRENCY = "USD"


def list_usd_packs() -> list[dict]:
    return USD_PACKS


def get_usd_pack(pack_id: str) -> dict | None:
    return USD_PACKS_BY_ID.get(pack_id)


def is_flw_configured() -> bool:
    return bool(settings.FLW_SECRET_KEY)


def _make_client() -> httpx.AsyncClient:
    """Force IPv4 to avoid DNS/network issues on some ISPs."""
    try:
        transport = httpx.AsyncHTTPTransport(local_address="0.0.0.0", retries=2)
        return httpx.AsyncClient(timeout=25, transport=transport)
    except Exception:
        # Fallback if transport trick fails
        return httpx.AsyncClient(timeout=25)


async def _post_with_retry(url: str, json_body: dict, headers: dict, attempts: int = 3):
    """POST with retry on network errors."""
    last_err = None
    for i in range(attempts):
        try:
            async with _make_client() as client:
                r = await client.post(url, json=json_body, headers=headers)
                return r.json()
        except Exception as e:
            last_err = e
            if i < attempts - 1:
                await asyncio.sleep(1.5)
    raise last_err if last_err else RuntimeError("Request failed")


async def _get_with_retry(url: str, headers: dict, attempts: int = 3):
    """GET with retry on network errors."""
    last_err = None
    for i in range(attempts):
        try:
            async with _make_client() as client:
                r = await client.get(url, headers=headers)
                return r.json()
        except Exception as e:
            last_err = e
            if i < attempts - 1:
                await asyncio.sleep(1.5)
    raise last_err if last_err else RuntimeError("Request failed")


async def initialize_transaction(
    db: Session,
    user_id: str,
    user_email: str,
    user_username: str,
    pack_id: str,
) -> dict:
    """Create Purchase row + initialize Flutterwave transaction."""
    pack = get_usd_pack(pack_id)
    if not pack:
        return {"ok": False, "error": "Invalid pack"}

    if not is_flw_configured():
        return {"ok": False, "error": "Global payments not configured yet"}

    tx_ref = f"flw_{uuid.uuid4().hex[:24]}"
    amount_cents = int(round(pack["amount_usd"] * 100))

    purchase = Purchase(
        user_id=user_id,
        reference=tx_ref,
        pack_id=pack_id,
        coins=pack["coins"],
        amount_kobo=amount_cents,
        currency=DEFAULT_CURRENCY,
        status="pending",
    )
    db.add(purchase)
    db.commit()

    body = {
        "tx_ref": tx_ref,
        "amount": str(pack["amount_usd"]),
        "currency": DEFAULT_CURRENCY,
        "redirect_url": settings.FLW_CALLBACK_URL,
        "customer": {
            "email": user_email,
            "name": user_username,
        },
        "customizations": {
            "title": "PlaySphere",
            "description": f"{pack['label']} — {pack['price_label']}",
        },
        "meta": {
            "user_id": user_id,
            "pack_id": pack_id,
            "coins": pack["coins"],
        },
    }
    headers = {
        "Authorization": f"Bearer {settings.FLW_SECRET_KEY}",
        "Content-Type": "application/json",
    }

    try:
        data = await _post_with_retry(
            f"{settings.FLW_BASE_URL}/payments",
            body,
            headers,
        )
    except Exception as e:
        return {"ok": False, "error": f"Flutterwave error: {e}"}

    if data.get("status") != "success":
        return {"ok": False, "error": data.get("message", "Init failed")}

    return {
        "ok": True,
        "reference": tx_ref,
        "authorization_url": data["data"]["link"],
    }


async def verify_transaction(db: Session, tx_ref: str) -> dict:
    """Verify via Flutterwave API, then grant coins (idempotent)."""
    if not is_flw_configured():
        return {"ok": False, "error": "Not configured"}

    purchase = db.query(Purchase).filter(Purchase.reference == tx_ref).first()
    if not purchase:
        return {"ok": False, "error": "Unknown reference"}

    if purchase.status == "paid":
        return {"ok": True, "already_paid": True, "coins": purchase.coins}

    headers = {"Authorization": f"Bearer {settings.FLW_SECRET_KEY}"}
    try:
        data = await _get_with_retry(
            f"{settings.FLW_BASE_URL}/transactions/verify_by_reference?tx_ref={tx_ref}",
            headers,
        )
    except Exception as e:
        return {"ok": False, "error": f"Verify failed: {e}"}

    if data.get("status") != "success":
        return {"ok": False, "error": data.get("message", "Verify failed")}

    tx = data.get("data", {})
    if tx.get("status") != "successful":
        purchase.status = "failed"
        db.commit()
        return {"ok": False, "error": f"Payment not successful: {tx.get('status')}"}

    paid_amount = float(tx.get("amount", 0))
    expected = purchase.amount_kobo / 100.0
    if paid_amount < expected - 0.01:
        return {"ok": False, "error": f"Amount mismatch: got {paid_amount}, expected {expected}"}

    purchase.status = "paid"
    purchase.paystack_ref = str(tx.get("id"))
    purchase.paid_at = datetime.now(timezone.utc)
    db.commit()

    try:
        grant_tokens(
            db,
            purchase.user_id,
            purchase.coins,
            reason=f"purchase_{purchase.pack_id}",
            idempotency_key=f"flw_grant:{purchase.reference}",
        )
        db.commit()
    except Exception as e:
        return {"ok": False, "error": f"Grant failed: {e}"}

    return {"ok": True, "coins": purchase.coins}


def verify_webhook_hash(header_value: str) -> bool:
    """Flutterwave sends verif-hash header that matches the secret hash you set."""
    if not settings.FLW_SECRET_HASH or not header_value:
        return False
    return header_value == settings.FLW_SECRET_HASH