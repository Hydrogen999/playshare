"""Flutterwave hosted checkout for the verification fee.

Re-uses your existing FLW_* settings (FLW_SECRET_KEY, FLW_SECRET_HASH,
FLW_BASE_URL). Money is never trusted from the app or from a webhook body: we
always ask Flutterwave directly (verify_by_reference) and use only that answer.
Google Pay / cards / transfer all come from Flutterwave's hosted page; enable
Google Pay in the Flutterwave dashboard under Settings > Payment methods.
"""

from __future__ import annotations

import secrets
from decimal import Decimal, InvalidOperation
from urllib.parse import urlparse

import httpx

from app.config import settings

TX_PREFIX = "vfy_"          # lets the shared webhook tell verification payments apart


class PaymentUnavailable(Exception):
    """Flutterwave not configured or temporarily unreachable."""


def configured() -> bool:
    return bool(settings.FLW_SECRET_KEY)


def return_url() -> str:
    if settings.VERIFICATION_RETURN_URL.startswith("https://"):
        return settings.VERIFICATION_RETURN_URL
    u = urlparse(settings.FLW_CALLBACK_URL)
    base = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else "http://localhost:8000"
    return f"{base}/verification/done"


def _headers() -> dict:
    return {"Authorization": f"Bearer {settings.FLW_SECRET_KEY}", "Content-Type": "application/json"}


def _default_http(method: str, url: str, body: dict | None = None) -> dict:
    try:
        r = httpx.request(method, url, headers=_headers(), json=body, timeout=20)
        return r.json()
    except Exception as e:
        raise PaymentUnavailable(f"Flutterwave unreachable: {e}") from None


def create_checkout(*, amount_cents: int, currency: str, application_id: str, user_id: str,
                    email: str, name: str, http=_default_http) -> tuple[str, str]:
    if not configured():
        raise PaymentUnavailable("Payments are not configured yet.")
    tx_ref = f"{TX_PREFIX}{application_id[:8]}_{secrets.token_hex(8)}"
    resp = http("POST", f"{settings.FLW_BASE_URL}/payments", {
        "tx_ref": tx_ref,
        "amount": str(Decimal(amount_cents) / 100),          # major units, e.g. "50"
        "currency": currency,
        "redirect_url": return_url(),
        "customer": {"email": email, "name": name or "Customer"},
        "customizations": {"title": settings.APP_NAME, "description": "Account verification fee"},
        "meta": {"application_id": application_id, "user_id": user_id, "kind": "verification"},
        "configurations": {"session_duration": 30},
    })
    link = (resp.get("data") or {}).get("link")
    if resp.get("status") != "success" or not isinstance(link, str) or not link.startswith("https://"):
        raise PaymentUnavailable("Payment could not be started. Please try again later.")
    return tx_ref, link


def verify_by_reference(tx_ref: str, http=_default_http) -> dict | None:
    """Ask Flutterwave what happened. Returns None when there is no such
    transaction yet (customer has not paid)."""
    if not configured():
        raise PaymentUnavailable("Payments are not configured yet.")
    resp = http("GET", f"{settings.FLW_BASE_URL}/transactions/verify_by_reference?tx_ref={tx_ref}", None)
    if resp.get("status") != "success" or not isinstance(resp.get("data"), dict):
        msg = str(resp.get("message", "")).lower()
        if "no transaction" in msg or "not found" in msg:
            return None
        raise PaymentUnavailable("Could not verify the payment right now.")
    d = resp["data"]
    if str(d.get("tx_ref")) != tx_ref:
        return None
    try:
        cents = int((Decimal(str(d.get("amount", 0))) * 100).to_integral_value())
    except (InvalidOperation, ValueError):
        raise PaymentUnavailable("Unreadable amount from payment provider.") from None
    return {"status": str(d.get("status", "")).lower(), "amount_cents": cents,
            "currency": str(d.get("currency", "")), "id": str(d.get("id", "")), "tx_ref": tx_ref}
