import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services.flutterwave import (
    get_usd_pack, initialize_transaction as flw_init,
    is_flw_configured, list_usd_packs,
    verify_transaction as flw_verify,
    verify_webhook_hash as flw_verify_hash,
)
from app.services.payments import (
    get_pack, initialize_transaction, list_packs,
    verify_transaction, verify_webhook_signature,
)

router = APIRouter(prefix="/api/v1/payments", tags=["payments"])


class CheckoutIn(BaseModel):
    pack_id: str


# ---------------------------------------------------------------------------
# PACKS
# ---------------------------------------------------------------------------


@router.get("/packs")
def get_packs(me: User = Depends(get_current_user)):
    """Return both NGN (Paystack) and USD (Flutterwave) packs."""
    return {
        "ngn_packs": list_packs(),
        "usd_packs": list_usd_packs(),
        "flw_available": is_flw_configured(),
    }


# ---------------------------------------------------------------------------
# PAYSTACK (NGN)
# ---------------------------------------------------------------------------


@router.post("/checkout")
async def checkout(
    data: CheckoutIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = await initialize_transaction(db, me.id, me.email, data.pack_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/verify/{reference}")
async def verify(
    reference: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.models.purchase import Purchase
    p = db.query(Purchase).filter(Purchase.reference == reference).first()
    if not p or p.user_id != me.id:
        raise HTTPException(status_code=404, detail="Purchase not found")

    result = await verify_transaction(db, reference)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    from app.services.ledger import get_balance
    return {
        "ok": True,
        "coins": result.get("coins", 0),
        "balance": get_balance(db, me.id),
    }


@router.post("/webhook")
async def webhook(request: Request, db: Session = Depends(get_db)):
    body = await request.body()
    signature = request.headers.get("x-paystack-signature", "")

    if not verify_webhook_signature(body, signature):
        raise HTTPException(status_code=401, detail="Invalid signature")

    try:
        event = json.loads(body)
    except Exception:
        return {"ok": True}

    if event.get("event") == "charge.success":
        reference = event.get("data", {}).get("reference")
        if reference:
            await verify_transaction(db, reference)

    return {"ok": True}


# ---------------------------------------------------------------------------
# FLUTTERWAVE (USD / Global)
# ---------------------------------------------------------------------------


class FLWCheckoutIn(BaseModel):
    pack_id: str


@router.post("/flw/checkout")
async def flw_checkout(
    data: FLWCheckoutIn,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    result = await flw_init(db, me.id, me.email, me.username, data.pack_id)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])
    return result


@router.get("/flw/verify/{tx_ref}")
async def flw_verify_endpoint(
    tx_ref: str,
    me: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from app.models.purchase import Purchase
    p = db.query(Purchase).filter(Purchase.reference == tx_ref).first()
    if not p or p.user_id != me.id:
        raise HTTPException(status_code=404, detail="Purchase not found")

    result = await flw_verify(db, tx_ref)
    if not result["ok"]:
        raise HTTPException(status_code=400, detail=result["error"])

    from app.services.ledger import get_balance
    return {
        "ok": True,
        "coins": result.get("coins", 0),
        "balance": get_balance(db, me.id),
    }


@router.post("/flutterwave/webhook")
async def flw_webhook(request: Request, db: Session = Depends(get_db)):
    """Flutterwave webhook — validates verif-hash header."""
    verif = request.headers.get("verif-hash", "")
    if not flw_verify_hash(verif):
        raise HTTPException(status_code=401, detail="Invalid hash")

    try:
        event = await request.json()
    except Exception:
        return {"ok": True}

    # Flutterwave sends events like "charge.completed"
    if event.get("event") == "charge.completed" or event.get("status") == "successful":
        data = event.get("data", {})
        tx_ref = data.get("tx_ref") or data.get("txRef")
        if tx_ref:
            await flw_verify(db, tx_ref)

    return {"ok": True}